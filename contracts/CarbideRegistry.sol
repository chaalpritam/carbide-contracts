// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title CarbideRegistry - permissionless storage provider registry
/// @notice Providers self-register their endpoint, tier, region, capacity, and
///         pricing. Clients (and indexers like carbide-discovery-service) read
///         directly from chain, removing the centralized discovery service as
///         a trust root. No admin, no allowlist: any address can register one
///         provider entry and update or deregister its own entry at any time.
contract CarbideRegistry {
    // -------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------

    /// Provider tier enumeration (mirrors the off-chain carbide-core enum).
    /// 0 = Home, 1 = Professional, 2 = Enterprise, 3 = GlobalCDN
    uint8 public constant MAX_TIER = 3;

    /// Upper bounds to keep gas and storage deterministic.
    uint256 public constant MAX_ENDPOINT_BYTES = 256;
    uint256 public constant MAX_REGION_BYTES = 32;

    struct Provider {
        string endpoint;          // e.g. "https://mac-mini.example:8080"
        string region;             // e.g. "NorthAmerica"
        uint128 pricePerGbMonth;   // USDC base units (6 decimals) per GB per month
        uint64 capacityGb;         // Advertised capacity in GB
        uint64 registeredAt;
        uint64 updatedAt;
        uint8 tier;                // 0..MAX_TIER
        bool active;               // Owner-controlled soft disable
    }

    // -------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------

    /// @notice Full provider record keyed by the registering address.
    mapping(address => Provider) private _providers;

    /// @notice Iterable list of registered owners. Order is not stable across
    ///         deregistrations (swap-and-pop on remove).
    address[] private _owners;

    /// @notice Position of each owner in `_owners` plus 1 (0 means unregistered).
    mapping(address => uint256) private _ownerIndex;

    // -------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------

    event ProviderRegistered(
        address indexed owner,
        string endpoint,
        string region,
        uint8 tier,
        uint64 capacityGb,
        uint128 pricePerGbMonth
    );

    event ProviderUpdated(
        address indexed owner,
        string endpoint,
        string region,
        uint8 tier,
        uint64 capacityGb,
        uint128 pricePerGbMonth
    );

    event ProviderActiveChanged(address indexed owner, bool active);

    event ProviderDeregistered(address indexed owner);

    // -------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------

    error AlreadyRegistered();
    error NotRegistered();
    error EndpointEmpty();
    error EndpointTooLong();
    error RegionEmpty();
    error RegionTooLong();
    error TierOutOfRange();
    error CapacityZero();
    error PriceZero();
    error PageOutOfRange();

    // -------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------

    modifier onlyRegistered() {
        if (_ownerIndex[msg.sender] == 0) revert NotRegistered();
        _;
    }

    // -------------------------------------------------------------------
    // Writes
    // -------------------------------------------------------------------

    /// @notice Register the caller as a new provider. Reverts if already
    ///         registered. Use `update` to change an existing entry.
    function register(
        string calldata endpoint,
        string calldata region,
        uint8 tier,
        uint64 capacityGb,
        uint128 pricePerGbMonth
    ) external {
        if (_ownerIndex[msg.sender] != 0) revert AlreadyRegistered();
        _validate(endpoint, region, tier, capacityGb, pricePerGbMonth);

        uint64 nowTs = uint64(block.timestamp);
        _providers[msg.sender] = Provider({
            endpoint: endpoint,
            region: region,
            pricePerGbMonth: pricePerGbMonth,
            capacityGb: capacityGb,
            registeredAt: nowTs,
            updatedAt: nowTs,
            tier: tier,
            active: true
        });

        _owners.push(msg.sender);
        _ownerIndex[msg.sender] = _owners.length;

        emit ProviderRegistered(msg.sender, endpoint, region, tier, capacityGb, pricePerGbMonth);
    }

    /// @notice Replace the caller's provider entry. Reverts if not registered.
    function update(
        string calldata endpoint,
        string calldata region,
        uint8 tier,
        uint64 capacityGb,
        uint128 pricePerGbMonth
    ) external onlyRegistered {
        _validate(endpoint, region, tier, capacityGb, pricePerGbMonth);

        Provider storage p = _providers[msg.sender];
        p.endpoint = endpoint;
        p.region = region;
        p.tier = tier;
        p.capacityGb = capacityGb;
        p.pricePerGbMonth = pricePerGbMonth;
        p.updatedAt = uint64(block.timestamp);

        emit ProviderUpdated(msg.sender, endpoint, region, tier, capacityGb, pricePerGbMonth);
    }

    /// @notice Flip the active flag without removing the entry. Inactive
    ///         providers are still listed so clients can see the history,
    ///         but should be filtered out when selecting a provider.
    function setActive(bool active) external onlyRegistered {
        Provider storage p = _providers[msg.sender];
        if (p.active != active) {
            p.active = active;
            p.updatedAt = uint64(block.timestamp);
            emit ProviderActiveChanged(msg.sender, active);
        }
    }

    /// @notice Remove the caller's entry entirely. Order-preserving is not
    ///         required on-chain; indexers reconstruct state from events.
    function deregister() external onlyRegistered {
        uint256 idx1 = _ownerIndex[msg.sender];   // 1-based
        uint256 idx = idx1 - 1;
        uint256 lastIdx = _owners.length - 1;

        if (idx != lastIdx) {
            address lastOwner = _owners[lastIdx];
            _owners[idx] = lastOwner;
            _ownerIndex[lastOwner] = idx1;
        }

        _owners.pop();
        delete _ownerIndex[msg.sender];
        delete _providers[msg.sender];

        emit ProviderDeregistered(msg.sender);
    }

    // -------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------

    function isRegistered(address owner) external view returns (bool) {
        return _ownerIndex[owner] != 0;
    }

    function getProvider(address owner) external view returns (Provider memory) {
        if (_ownerIndex[owner] == 0) revert NotRegistered();
        return _providers[owner];
    }

    function providerCount() external view returns (uint256) {
        return _owners.length;
    }

    /// @notice Paginated read of (owner, provider) tuples. Clients should
    ///         iterate pages rather than pulling the full list at once when
    ///         the registry grows large.
    /// @param offset Zero-based starting index.
    /// @param limit  Maximum rows to return; pass 0 for "until end of list".
    function getProvidersPage(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory owners, Provider[] memory records)
    {
        uint256 total = _owners.length;
        if (total == 0) {
            return (new address[](0), new Provider[](0));
        }
        if (offset >= total) revert PageOutOfRange();

        uint256 end = limit == 0 ? total : offset + limit;
        if (end > total) end = total;
        uint256 len = end - offset;

        owners = new address[](len);
        records = new Provider[](len);
        for (uint256 i = 0; i < len; i++) {
            address o = _owners[offset + i];
            owners[i] = o;
            records[i] = _providers[o];
        }
    }

    // -------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------

    function _validate(
        string calldata endpoint,
        string calldata region,
        uint8 tier,
        uint64 capacityGb,
        uint128 pricePerGbMonth
    ) internal pure {
        if (bytes(endpoint).length == 0) revert EndpointEmpty();
        if (bytes(endpoint).length > MAX_ENDPOINT_BYTES) revert EndpointTooLong();
        if (bytes(region).length == 0) revert RegionEmpty();
        if (bytes(region).length > MAX_REGION_BYTES) revert RegionTooLong();
        if (tier > MAX_TIER) revert TierOutOfRange();
        if (capacityGb == 0) revert CapacityZero();
        if (pricePerGbMonth == 0) revert PriceZero();
    }
}
