// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title CarbideEscrow - USDC escrow for storage payments
/// @notice Clients deposit USDC upfront. Monthly releases to providers after
///         proof-of-storage verification via EIP-712 signed attestations.
contract CarbideEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    // -------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------

    struct Escrow {
        address client;
        address provider;
        address token;           // USDC address
        uint256 totalAmount;     // Total deposited
        uint256 releasedAmount;  // Released so far
        uint32 totalPeriods;     // Total payment periods (months)
        uint32 periodsReleased;  // Periods paid out
        uint64 createdAt;
        bool active;
        bool disputed;
    }

    // -------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------

    address public owner;
    uint256 public nextEscrowId;
    mapping(uint256 => Escrow) public escrows;
    mapping(address => bool) public authorizedVerifiers;

    // EIP-712 domain separator
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant PAYMENT_RELEASE_TYPEHASH = keccak256(
        "PaymentRelease(uint256 escrowId,uint32 period,address provider,uint256 amount,bytes32 proofHash)"
    );

    // -------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------

    event EscrowCreated(uint256 indexed escrowId, address indexed client, address indexed provider, uint256 amount, uint32 totalPeriods);
    event PaymentReleased(uint256 indexed escrowId, uint32 period, uint256 amount, bytes32 proofHash);
    event EscrowCompleted(uint256 indexed escrowId);
    event EscrowCancelled(uint256 indexed escrowId, uint256 refundedAmount);
    event EscrowDisputed(uint256 indexed escrowId, address disputedBy);
    event DisputeResolved(uint256 indexed escrowId, uint256 providerAmount, uint256 clientAmount);
    event VerifierAdded(address indexed verifier);
    event VerifierRemoved(address indexed verifier);

    // -------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "CarbideEscrow: not owner");
        _;
    }

    modifier escrowExists(uint256 escrowId) {
        require(escrowId < nextEscrowId, "CarbideEscrow: escrow does not exist");
        _;
    }

    modifier escrowActive(uint256 escrowId) {
        require(escrows[escrowId].active, "CarbideEscrow: escrow not active");
        require(!escrows[escrowId].disputed, "CarbideEscrow: escrow is disputed");
        _;
    }

    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------

    constructor() {
        owner = msg.sender;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("CarbideEscrow"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // -------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------

    /// @notice Add an authorized proof verifier
    function addVerifier(address verifier) external onlyOwner {
        authorizedVerifiers[verifier] = true;
        emit VerifierAdded(verifier);
    }

    /// @notice Remove an authorized proof verifier
    function removeVerifier(address verifier) external onlyOwner {
        authorizedVerifiers[verifier] = false;
        emit VerifierRemoved(verifier);
    }

    // -------------------------------------------------------------------
    // Core: Create Escrow
    // -------------------------------------------------------------------

    /// @notice Client deposits USDC into escrow for a storage contract
    /// @param provider Address of the storage provider (payee)
    /// @param token USDC token address
    /// @param totalAmount Total USDC to deposit (with 6 decimals)
    /// @param totalPeriods Number of payment periods (months)
    /// @return escrowId The ID of the created escrow
    function createEscrow(
        address provider,
        address token,
        uint256 totalAmount,
        uint32 totalPeriods
    ) external returns (uint256 escrowId) {
        require(provider != address(0), "CarbideEscrow: zero provider address");
        require(totalAmount > 0, "CarbideEscrow: zero amount");
        require(totalPeriods > 0, "CarbideEscrow: zero periods");

        // Transfer USDC from client to this contract using SafeERC20
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalAmount);

        escrowId = nextEscrowId++;
        escrows[escrowId] = Escrow({
            client: msg.sender,
            provider: provider,
            token: token,
            totalAmount: totalAmount,
            releasedAmount: 0,
            totalPeriods: totalPeriods,
            periodsReleased: 0,
            createdAt: uint64(block.timestamp),
            active: true,
            disputed: false
        });

        emit EscrowCreated(escrowId, msg.sender, provider, totalAmount, totalPeriods);
    }

    // -------------------------------------------------------------------
    // Core: Release Payment
    // -------------------------------------------------------------------

    /// @notice Release payment for a period after proof-of-storage verification
    /// @param escrowId The escrow to release from
    /// @param period The period number being paid (1-indexed)
    /// @param proofHash Hash of the storage proof
    /// @param signature EIP-712 signature from authorized verifier
    function releasePayment(
        uint256 escrowId,
        uint32 period,
        bytes32 proofHash,
        bytes memory signature
    ) external nonReentrant escrowExists(escrowId) escrowActive(escrowId) {
        Escrow storage e = escrows[escrowId];

        require(period == e.periodsReleased + 1, "CarbideEscrow: wrong period");
        require(period <= e.totalPeriods, "CarbideEscrow: period exceeds total");

        // Calculate per-period amount
        uint256 amount = e.totalAmount / e.totalPeriods;
        // Last period gets the remainder
        if (period == e.totalPeriods) {
            amount = e.totalAmount - e.releasedAmount;
        }

        // Verify EIP-712 signature from authorized verifier
        bytes32 structHash = keccak256(
            abi.encode(PAYMENT_RELEASE_TYPEHASH, escrowId, period, e.provider, amount, proofHash)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address signer = digest.recover(signature);
        require(authorizedVerifiers[signer], "CarbideEscrow: invalid verifier signature");

        // Update state before transfer (checks-effects-interactions)
        e.releasedAmount += amount;
        e.periodsReleased = period;

        // Check if fully released
        if (e.periodsReleased == e.totalPeriods) {
            e.active = false;
        }

        // Transfer USDC to provider using SafeERC20
        IERC20(e.token).safeTransfer(e.provider, amount);

        emit PaymentReleased(escrowId, period, amount, proofHash);

        if (e.periodsReleased == e.totalPeriods) {
            emit EscrowCompleted(escrowId);
        }
    }

    // -------------------------------------------------------------------
    // Core: Cancel / Dispute
    // -------------------------------------------------------------------

    /// @notice Client cancels escrow and reclaims unreleased funds
    function cancelEscrow(uint256 escrowId) external nonReentrant escrowExists(escrowId) escrowActive(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(msg.sender == e.client, "CarbideEscrow: not client");

        uint256 refund = e.totalAmount - e.releasedAmount;
        e.active = false;

        if (refund > 0) {
            IERC20(e.token).safeTransfer(e.client, refund);
        }

        emit EscrowCancelled(escrowId, refund);
    }

    /// @notice Raise a dispute on an escrow (client or provider)
    function raiseDispute(uint256 escrowId) external escrowExists(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(e.active, "CarbideEscrow: escrow not active");
        require(
            msg.sender == e.client || msg.sender == e.provider,
            "CarbideEscrow: not a party"
        );
        e.disputed = true;
        emit EscrowDisputed(escrowId, msg.sender);
    }

    /// @notice Owner resolves a dispute by splitting remaining funds
    function resolveDispute(
        uint256 escrowId,
        uint256 providerAmount,
        uint256 clientAmount
    ) external nonReentrant onlyOwner escrowExists(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(e.disputed, "CarbideEscrow: not disputed");

        uint256 remaining = e.totalAmount - e.releasedAmount;
        require(providerAmount + clientAmount == remaining, "CarbideEscrow: amounts must equal remaining");

        e.active = false;
        e.disputed = false;
        e.releasedAmount = e.totalAmount;

        if (providerAmount > 0) {
            IERC20(e.token).safeTransfer(e.provider, providerAmount);
        }
        if (clientAmount > 0) {
            IERC20(e.token).safeTransfer(e.client, clientAmount);
        }

        emit DisputeResolved(escrowId, providerAmount, clientAmount);
    }

    // -------------------------------------------------------------------
    // View functions
    // -------------------------------------------------------------------

    /// @notice Get escrow details
    function getEscrow(uint256 escrowId) external view escrowExists(escrowId) returns (Escrow memory) {
        return escrows[escrowId];
    }

    /// @notice Get remaining balance in an escrow
    function getRemainingBalance(uint256 escrowId) external view escrowExists(escrowId) returns (uint256) {
        return escrows[escrowId].totalAmount - escrows[escrowId].releasedAmount;
    }

    /// @notice Get the current payment period for an escrow
    function getCurrentPeriod(uint256 escrowId) external view escrowExists(escrowId) returns (uint32) {
        return escrows[escrowId].periodsReleased + 1;
    }
}
