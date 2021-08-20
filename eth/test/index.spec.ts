import { ethers, waffle, network } from 'hardhat'
import { Signer, BigNumber } from 'ethers'
import chai from 'chai'

import PrideSeasonArtifact from '../artifacts/contracts/PrideSeason.sol/PrideSeason.json'
import { PrideSeason } from '../typechain/PrideSeason'
import ERC20PresetMinterPauserArtifact from '../artifacts/@openzeppelin/contracts/token/ERC20/presets/ERC20PresetMinterPauser.sol/ERC20PresetMinterPauser.json'
import { ERC20PresetMinterPauser } from '../typechain/ERC20PresetMinterPauser'

import { merkleRootAndProofs } from '../scripts/merkleProof'

const { deployContract } = waffle
const { expect } = chai

test('I run typescript tests using waffle chai matchers', (): void => {
  const t: boolean = true
  expect(t).to.equal(true)
})

describe('Sales and returns', () => {
  let prideSeason: PrideSeason
  let reserveToken: ERC20PresetMinterPauser
  let deployer: Signer
  let alice: Signer
  let bob: Signer
  let deployerAddr: string
  let aliceAddr: string
  let bobAddr: string
  const reserveTokenName = 'Mock Reserve Token'
  const reserveTokenSymbol = 'MRT'
  const seasonName = 'Test season name'
  const seasonSymbol = 'TPS'
  const refundBasisPoints = 8000
  const includedDrawings = [
    'testDrawingA',
    'testDrawingB',
    'testDrawingC'
  ]

  const { root, proofs } = merkleRootAndProofs(includedDrawings)
  let deployerReserve: ERC20PresetMinterPauser
  let aliceReserve: ERC20PresetMinterPauser
  let bobReserve: ERC20PresetMinterPauser
  let alicePride: PrideSeason
  let bobPride: PrideSeason

  beforeEach(async () => {
    const signers: Signer[] = await ethers.getSigners()
    if (signers[0] === undefined || signers[1] === undefined || signers[2] === undefined) {
      throw new Error('could not get signers')
    }
    deployer = signers[0]
    deployerAddr = await deployer.getAddress()
    alice = signers[1]
    aliceAddr = await alice.getAddress()
    bob = signers[2]
    bobAddr = await bob.getAddress()
    reserveToken = (await deployContract(
      deployer,
      ERC20PresetMinterPauserArtifact,
      [reserveTokenName, reserveTokenSymbol]
    )) as ERC20PresetMinterPauser

    deployerReserve = reserveToken.connect(deployer)
    aliceReserve = reserveToken.connect(alice)
    bobReserve = reserveToken.connect(bob)
    await deployerReserve.mint(deployerAddr, ethers.utils.parseEther('500'))
    await deployerReserve.mint(aliceAddr, ethers.utils.parseEther('500'))
    await deployerReserve.mint(bobAddr, ethers.utils.parseEther('500'))

    prideSeason = (await deployContract(
      deployer,
      PrideSeasonArtifact,
      [
        seasonName,
        seasonSymbol,
        root,
        refundBasisPoints,
        reserveToken.address,
        deployerAddr
      ]
    )) as PrideSeason

    alicePride = prideSeason.connect(alice)
    bobPride = prideSeason.connect(bob)
  })

  afterEach(async () => {
    await network.provider.request({
      method: 'hardhat_reset',
      params: []
    })
  })

  test('It mints and sells never sold available drawings', async () => {
    const price = await alicePride.getPrice()
    const refundAmount = await alicePride.getSpeculativeRefundAmount(1)
    const drawing = includedDrawings[0] ?? ''
    const proof = proofs[drawing] ?? []
    if (proof === []) {
      throw new Error('missing proof')
    }
    await aliceReserve.approve(prideSeason.address, price)

    // alice balance should be 0 before buying and 1 after
    expect(await alicePride.balanceOf(aliceAddr)).to.be.equal(0)
    // alice should transfer proce to the contract address
    await expect(async () => {
      return await alicePride.buy(aliceAddr, drawing, proof, price)
    }).to.changeTokenBalances(
      reserveToken,
      [alice, { getAddress: () => prideSeason.address }, deployer],
      [price.mul(-1), refundAmount, price.sub(refundAmount)]
    )

    expect(await alicePride.balanceOf(aliceAddr)).to.be.equal(1)

    // totalOwned should have increased by 1
    expect(await alicePride.getTotalOwned()).to.be.equal(1)

    await bobReserve.approve(prideSeason.address, price)

    await expect(
      bobPride.buy(
        aliceAddr,
        'unincludedDrawing',
        proof,
        price
      )
    ).to.be.reverted

    await expect(
      bobPride.buy(
        aliceAddr,
        'unincludedDrawing',
        [],
        price
      )
    ).to.be.reverted

    // bob shouldn't own any nfts
    expect((await bobPride.balanceOf(bobAddr)).eq(0)).to.be.equal(true)
    // totalOwned should not change
    expect(await alicePride.getTotalOwned()).to.be.equal(1)
  })

  test('It accepts returns by the owner for a refund', async () => {
    const price = await alicePride.getPrice()
    const drawing = includedDrawings[0] ?? ''
    const proof = proofs[drawing] ?? []
    if (proof === []) {
      throw new Error('missing proof')
    }
    await aliceReserve.approve(prideSeason.address, price)
    await alicePride.buy(
      aliceAddr,
      drawing,
      proof,
      price
    )

    const id = 1 // should be the one and only minted drawing
    const refundAmount = await alicePride.getRefundAmount()

    await expect(
      bobPride.returnForRefund(id, refundAmount)
    ).to.be.revertedWith(
      'msg.sender is not Owner'
    )

    await alicePride.approve(prideSeason.address, id)
    // alice should be transfered refundAmount
    await expect(async () => {
      return await alicePride.returnForRefund(id, refundAmount)
    }).to.changeTokenBalance(reserveToken, alice, refundAmount)

    // alice should not own id 1
    expect((await alicePride.balanceOf(aliceAddr)).toNumber()).to.be.equal(0)

    // the pride contract should own id 1
    expect(await alicePride.ownerOf(1)).to.be.equal(prideSeason.address)

    // totalOwned should go down by one
    expect((await alicePride.getTotalOwned()).toNumber()).to.be.equal(0)

    // returnedDrawings[drawing] should be id
    expect((await alicePride.getReturnedId(drawing)).toNumber()).to.be.equal(1)

    // then will sell them
    await bobReserve.approve(prideSeason.address, price)
    await expect(async () => {
      return await bobPride.buy(bobAddr, drawing, proof, price)
    }).to.changeTokenBalances(
      reserveToken,
      [bob, { getAddress: () => prideSeason.address }],
      [price.mul(-1), refundAmount] // the rest goes to the beneficiary
    )

    // bob should own id 1
    expect((await bobPride.balanceOf(bobAddr)).toNumber()).to.be.equal(1)
    expect(await bobPride.ownerOf(1)).to.be.equal(bobAddr)

    // totalOwned should be 1
    expect((await bobPride.getTotalOwned()).toNumber()).to.be.equal(1)

    // returnedDrawings[drawing] should be 0
    expect((await bobPride.getReturnedId(drawing)).toNumber()).to.be.equal(0)
  })

  test('It reverts if min or max price is violated', async () => {
    const price = await alicePride.getPrice()
    const drawing = includedDrawings[0] ?? ''
    const proof = proofs[drawing] ?? []
    if (proof === []) {
      throw new Error('missing proof')
    }
    await aliceReserve.approve(prideSeason.address, price)
    await expect(
      alicePride.buy(aliceAddr, drawing, proof, price.sub(1))
    ).to.be.reverted

    // alice should not own it (it should not exist)

    await alicePride.buy(aliceAddr, drawing, proof, price)

    // alice should own it
    // ID should be 1
    const id = 1

    const refundAmount = await alicePride.getRefundAmount()
    await expect(
      alicePride.returnForRefund(id, refundAmount.add(1))
    ).to.be.reverted

    // alice should own it

    await alicePride.returnForRefund(id, refundAmount)

    // alice should not own it
  })

  test('The price follows the curve with no overflows', async () => {
    // the curve is price = (10^17 * owned)^2 ERC20 (18 decimal places)
    const maxMintedBits = 16
    const zero = ethers.BigNumber.from(0)
    const max = ethers.BigNumber.from(2).pow(maxMintedBits).sub(1)

    function curvePrice (owned: number): BigNumber {
      return zero.add(10).pow(8).mul(owned).pow(2)
    }

    expect(curvePrice(1).eq(await alicePride.getSpeculativePrice(1))).to.be.equal(true)
    expect(curvePrice(10).eq(await alicePride.getSpeculativePrice(10))).to.be.equal(true)
    expect(curvePrice(100).eq(await alicePride.getSpeculativePrice(100))).to.be.equal(true)
    const maxPrice = curvePrice(max.toNumber())
    expect(maxPrice.eq(await alicePride.getSpeculativePrice(max))).to.be.equal(true)

    // getting the price when zero have been sold gives the first price
    expect(await alicePride.getPrice()).to.equal(curvePrice(1))

    const maxRefund = await alicePride.getSpeculativeRefundAmount(max)
    expect(maxPrice.mul(refundBasisPoints).div(10000).eq(maxRefund)).to.be.equal(true)
  })

  test("It doesn't mint anytning more than once", async () => {
    const whaleStack = ethers.utils.parseEther('1000000')
    await aliceReserve.approve(prideSeason.address, whaleStack)
    for (const drawing of includedDrawings) {
      const proof = proofs[drawing] ?? []
      await alicePride.buy(aliceAddr, drawing, proof, whaleStack)
    }

    for (const drawing of includedDrawings) {
      const proof = proofs[drawing] ?? []
      await expect(
        alicePride.buy(aliceAddr, drawing, proof, whaleStack)
      ).to.be.reverted
    }
  })

  test('It pays the beneficiary', async () => {
    const price = await alicePride.getPrice()
    const refundAmount = await alicePride.getSpeculativeRefundAmount(1)
    const drawing = includedDrawings[0] ?? ''
    const proof = proofs[drawing] ?? []
    await aliceReserve.approve(prideSeason.address, price)
    await expect(async () => {
      return await alicePride.buy(aliceAddr, drawing, proof, price)
    }).to.changeTokenBalances(
      reserveToken,
      [alice, { getAddress: () => prideSeason.address }, deployer],
      [price.mul(-1), refundAmount, price.sub(refundAmount)]
    )
  })
})
