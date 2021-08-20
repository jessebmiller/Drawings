//SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import "hardhat/console.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";

contract PrideSeason is ERC721URIStorage, IERC721Receiver {
    using SafeMath for uint256;
    using SafeMath for uint16;
    using SafeERC20 for IERC20;
    using Counters for Counters.Counter;
    Counters.Counter private _tokenIds;

    uint256 public maxMinted;

    // keccak(drawingURI) => bool owned?
    mapping(bytes32 => bool) public ownedDrawings;
    Counters.Counter public totalOwned;

    // keccak(drawingURI) => bool
    mapping(bytes32 => uint256) public returnedDrawings;

    bytes32 public includedDrawingsMerkleRoot;

    IERC20 public reserveToken;

    uint16 public refundBasisPoints; // sell price portion of buy price

    constructor(
        string memory seasonName,
        string memory seasonSymbol,
        bytes32 _includedDrawingsMerkleRoot,
        uint16 _refundBasisPoints,
        IERC20 _reserveToken
    ) ERC721(seasonName, seasonSymbol) {
        require(
            refundBasisPoints <= 10 * 1000,
            "Sell price higher than buy price"
        );
        includedDrawingsMerkleRoot = _includedDrawingsMerkleRoot;
        refundBasisPoints = _refundBasisPoints;
        reserveToken = _reserveToken;
    }

    modifier onlyAvailable(
        string memory drawingURI,
        bytes32[] memory proofOfInclusion
    ) {
        // isn't owned
        require(
            ownedDrawings[keccak256(bytes(drawingURI))] == false,
            "Drawing has already been sold"
        );
        // is included in the season
        bool validProof = MerkleProof.verify(
            proofOfInclusion,
            includedDrawingsMerkleRoot,
            keccak256(bytes(drawingURI))
        );
        require(validProof, "No proof of inclusion");
        _;
    }

    modifier onlyOwner(uint256 id) {
        require(msg.sender == ownerOf(id), "msg.sender is not Owner");
        _;
    }

    function buy(
        address to,
        string memory drawingURI,
        bytes32[] memory proofOfInclusion,
        uint256 maxPrice
    ) public onlyAvailable(drawingURI, proofOfInclusion) returns (uint256) {
        // charge price
        uint256 price = getPrice();
        require(price <= maxPrice, "Price higher than maxPrice");

        reserveToken.safeTransferFrom(msg.sender, address(this), price);

        bytes32 drawingKey = keccak256(bytes(drawingURI));
        ownedDrawings[drawingKey] = true;
        totalOwned.increment();

        // transfer if it had been minted and returned
        uint256 returnedId = returnedDrawings[drawingKey];
        if (returnedId > 0) {
            _safeTransfer(address(this), to, returnedId, "");
            returnedDrawings[drawingKey] = 0;
            return returnedId;
        }

        // mint otherwise
        _tokenIds.increment();
        uint256 newId = _tokenIds.current();
        _mint(to, newId);
        _setTokenURI(newId, drawingURI);

        return newId;
    }

    function returnForRefund(uint256 id, uint256 minRefund)
        public
        onlyOwner(id)
    {
        uint256 refundAmount = getRefundAmount();
        require(refundAmount >= minRefund, "Refund lower than minRefund");
        reserveToken.safeTransfer(msg.sender, refundAmount);
        safeTransferFrom(msg.sender, address(this), id);
        bytes32 drawingKey = keccak256(bytes(tokenURI(id)));
        ownedDrawings[drawingKey] = false;
        totalOwned.decrement();
        bytes memory uri = bytes(tokenURI(id));
        returnedDrawings[keccak256(uri)] = id;
    }

    function getPrice() public view returns (uint256) {
        return getSpeculativePrice(totalOwned.current().add(1));
    }

    function getSpeculativePrice(uint256 nth) public pure returns (uint256) {
        // this has been tested up to an nth of 2**16-1, the max that
        // can be minted
        return (nth.mul(10**8)**2);
    }

    function getRefundAmount() public view returns (uint256) {
        // is this close to overflowing?
        return getSpeculativeRefundAmount(totalOwned.current());
    }

    function getSpeculativeRefundAmount(uint256 nth)
        public
        view
        returns (uint256)
    {
        return getSpeculativePrice(nth).mul(refundBasisPoints).div(10000);
    }

    function getTotalOwned() public view returns (uint256) {
        return totalOwned.current();
    }

    function getReturnedId(string memory drawing)
        public
        view
        returns (uint256)
    {
        return returnedDrawings[keccak256(bytes(drawing))];
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes memory
    ) public virtual override returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
