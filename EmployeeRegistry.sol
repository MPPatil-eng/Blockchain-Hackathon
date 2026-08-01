// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts@5.0.2/access/Ownable.sol";

/// @title EmployeeRegistry
/// @notice On-chain identity check for the ProofPay dashboard login screen.
///         The owner (HR / admin wallet) registers each employee's Company ID,
///         name, and wallet address. At login, the frontend calls checkLogin()
///         with what the user typed plus the MetaMask address they verified,
///         and gets back a status code telling it exactly what's wrong (if
///         anything) without leaking which specific field failed to an
///         attacker beyond what the UI already chooses to show.
contract EmployeeRegistry is Ownable {
    /// @dev Owner wallet is hardcoded here so Remix needs NO constructor
    ///      argument when deploying — just click Deploy directly.
    ///      Change this address before deploying if you want a different owner.
    address private constant INITIAL_OWNER = 0xcb522083f04D9578fe4D8283F54b6A46185BB15c;

    struct Employee {
        string name;
        address wallet;
        bool exists;
    }

    /// @dev Keyed by Company ID.
    mapping(string => Employee) private employees;

    event EmployeeAdded(string indexed companyId, string name, address wallet);
    event EmployeeUpdated(string indexed companyId, string name, address wallet);
    event EmployeeRemoved(string indexed companyId);

    constructor() Ownable(INITIAL_OWNER) {}

    /* ============================================================
       ADMIN — owner only
       ============================================================ */

    /// @notice Register a new employee. Reverts if the Company ID is already in use.
    function addEmployee(string calldata companyId, string calldata name, address wallet) external onlyOwner {
        require(bytes(companyId).length > 0, "EmployeeRegistry: companyId cannot be empty");
        require(bytes(name).length > 0, "EmployeeRegistry: name cannot be empty");
        require(wallet != address(0), "EmployeeRegistry: wallet cannot be zero address");
        require(!employees[companyId].exists, "EmployeeRegistry: companyId already registered");

        employees[companyId] = Employee({name: name, wallet: wallet, exists: true});
        emit EmployeeAdded(companyId, name, wallet);
    }

    /// @notice Convenience: register many employees in a single transaction.
    ///         Arrays must be the same length and index-aligned.
    function addEmployeesBulk(
        string[] calldata companyIds,
        string[] calldata names,
        address[] calldata wallets
    ) external onlyOwner {
        require(
            companyIds.length == names.length && names.length == wallets.length,
            "EmployeeRegistry: array length mismatch"
        );
        for (uint256 i = 0; i < companyIds.length; i++) {
            require(bytes(companyIds[i]).length > 0, "EmployeeRegistry: companyId cannot be empty");
            require(bytes(names[i]).length > 0, "EmployeeRegistry: name cannot be empty");
            require(wallets[i] != address(0), "EmployeeRegistry: wallet cannot be zero address");
            require(!employees[companyIds[i]].exists, "EmployeeRegistry: companyId already registered");

            employees[companyIds[i]] = Employee({name: names[i], wallet: wallets[i], exists: true});
            emit EmployeeAdded(companyIds[i], names[i], wallets[i]);
        }
    }

    /// @notice Update an existing employee's name and/or wallet. Reverts if not registered.
    function updateEmployee(string calldata companyId, string calldata name, address wallet) external onlyOwner {
        require(employees[companyId].exists, "EmployeeRegistry: companyId not registered");
        require(bytes(name).length > 0, "EmployeeRegistry: name cannot be empty");
        require(wallet != address(0), "EmployeeRegistry: wallet cannot be zero address");

        employees[companyId].name = name;
        employees[companyId].wallet = wallet;
        emit EmployeeUpdated(companyId, name, wallet);
    }

    /// @notice Remove an employee from the registry. Reverts if not registered.
    function removeEmployee(string calldata companyId) external onlyOwner {
        require(employees[companyId].exists, "EmployeeRegistry: companyId not registered");
        delete employees[companyId];
        emit EmployeeRemoved(companyId);
    }

    /* ============================================================
       READ — used by the frontend
       ============================================================ */

    /// @notice Look up an employee record directly.
    function getEmployee(string calldata companyId)
        external
        view
        returns (string memory name, address wallet, bool exists)
    {
        Employee storage e = employees[companyId];
        return (e.name, e.wallet, e.exists);
    }

    /// @notice Login check used by the dashboard.
    /// @return status 0 = companyId not found, 1 = name does not match,
    ///         2 = wallet does not match, 3 = ok (all three match).
    function checkLogin(string calldata companyId, string calldata name, address wallet)
        external
        view
        returns (uint8 status)
    {
        Employee storage e = employees[companyId];
        if (!e.exists) {
            return 0;
        }
        if (!_stringsEqual(e.name, name)) {
            return 1;
        }
        if (e.wallet != wallet) {
            return 2;
        }
        return 3;
    }

    /// @dev Exact, case-sensitive string comparison.
    function _stringsEqual(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
