// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts@5.0.2/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts@5.0.2/access/Ownable.sol";

/// @title ProofPayRewards
/// @notice ERC20 reward token for the ProofPay AI demo.
///         An off-chain LLM computes an employee performance score. A trusted
///         "oracle" address (your backend / AI service wallet) writes that score
///         on-chain for the employee's address. The employee then calls claim()
///         themselves from their own MetaMask account to mint their reward,
///         which lands directly in their wallet.
contract ProofPayRewards is ERC20, Ownable {
    /// @dev Oracle wallet is hardcoded here so Remix needs NO constructor
    ///      argument when deploying — just click Deploy directly.
    ///      Change this address before deploying if you want a different oracle.
    address private constant INITIAL_ORACLE = 0xcb522083f04D9578fe4D8283F54b6A46185BB15c;

    /// @notice Address allowed to record scores on-chain. Set by the owner,
    ///         normally the wallet your backend/LLM service signs with.
    address public oracle;

    /// @notice Latest recorded performance score per employee (0-100 scale expected).
    mapping(address => uint256) public scores;

    /// @notice Timestamp of each employee's most recent successful claim.
    mapping(address => uint256) public lastClaimTime;

    /// @notice Minimum time an employee must wait between claims. ~3 months.
    uint256 public constant CLAIM_COOLDOWN = 90 days;

    event ScoreSet(address indexed employee, uint256 score);
    event Claimed(address indexed employee, uint256 score, uint256 rewardAmount);
    event OracleUpdated(address indexed newOracle);

    modifier onlyOracle() {
        require(msg.sender == oracle, "ProofPayRewards: caller is not the oracle");
        _;
    }

    constructor() ERC20("ProofPay Reward", "PPAY") Ownable(msg.sender) {
        oracle = INITIAL_ORACLE;
        emit OracleUpdated(INITIAL_ORACLE);
    }

    /// @notice Update which address is trusted to submit scores. Owner only.
    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "ProofPayRewards: oracle cannot be zero address");
        oracle = newOracle;
        emit OracleUpdated(newOracle);
    }

    /// @notice Record an employee's AI-generated performance score on-chain.
    ///         The score itself is computed off-chain by the LLM (a smart contract
    ///         cannot call external APIs); this is the trusted oracle writing that
    ///         result on-chain. Overwrites any previous score. Does not affect the
    ///         claim cooldown.
    /// @param employee Employee wallet address.
    /// @param score Performance score, e.g. 0-100.
    function setScore(address employee, uint256 score) external onlyOracle {
        require(employee != address(0), "ProofPayRewards: employee cannot be zero address");
        scores[employee] = score;
        emit ScoreSet(employee, score);
    }

    /// @notice Employee-called: mints their reward based on their current on-chain score.
    ///         Only pays out if score is above 50, and only once every CLAIM_COOLDOWN
    ///         (3 months) per employee, regardless of how often their score changes.
    function claim() external {
        require(
            block.timestamp >= lastClaimTime[msg.sender] + CLAIM_COOLDOWN,
            "ProofPayRewards: next reward not available yet"
        );
        uint256 score = scores[msg.sender];
        require(score > 50, "ProofPayRewards: score must be above 50 to claim");

        uint256 reward = score + _sqrt(50 + score);
        lastClaimTime[msg.sender] = block.timestamp;

        _mint(msg.sender, reward * 10 ** decimals());
        emit Claimed(msg.sender, score, reward);
    }

    /// @notice View helper so a frontend can show the expected reward before claiming.
    function previewReward(address employee) external view returns (uint256) {
        uint256 score = scores[employee];
        if (score <= 50) return 0;
        return score + _sqrt(50 + score);
    }

    /// @notice View helper: whether an employee can claim right now.
    function canClaim(address employee) external view returns (bool) {
        return block.timestamp >= lastClaimTime[employee] + CLAIM_COOLDOWN && scores[employee] > 50;
    }

    /// @notice View helper: unix timestamp at which an employee's next claim opens up.
    ///         For an employee who has never claimed, this returns a timestamp in
    ///         the past (epoch + 90 days), meaning they can claim immediately
    ///         (subject to having a qualifying score).
    function nextClaimTime(address employee) external view returns (uint256) {
        return lastClaimTime[employee] + CLAIM_COOLDOWN;
    }

    /// @dev Integer square root (Babylonian method), floors the result.
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
