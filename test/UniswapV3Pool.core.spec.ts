import { ethers, waffle } from 'hardhat'
import { BigNumber, constants, Wallet } from 'ethers'
import { TestERC20 } from '../typechain/TestERC20'
import { UniswapV3Factory } from '../typechain/UniswapV3Factory'
import { MockTimeUniswapV3Pool } from '../typechain/MockTimeUniswapV3Pool'
import { TestUniswapV3Callee } from '../typechain/TestUniswapV3Callee'
import { expect } from './shared/expect'
import { poolFixture } from './shared/fixtures'
import {
  expandTo18Decimals,
  FeeAmount,
  getPositionKey,
  getMinTick,
  getMaxTick,
  encodePriceSqrt,
  TICK_SPACINGS,
  createPoolFunctions,
  SwapFunction,
  MintFunction,
  MaxUint128,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
} from './shared/utilities'

const createFixtureLoader = waffle.createFixtureLoader

function bnCloseTo(actual: BigNumber, expected: BigNumber, tolerance: number): boolean {
  const diff = actual.gt(expected) ? actual.sub(expected) : expected.sub(actual)
  return diff.lte(tolerance)
}

describe('UniswapV3Pool - Core Innovation Tests', () => {
  let wallet: Wallet, other: Wallet

  let token0: TestERC20
  let token1: TestERC20
  let token2: TestERC20

  let factory: UniswapV3Factory
  let pool: MockTimeUniswapV3Pool

  let swapTarget: TestUniswapV3Callee

  let swapExact0For1: SwapFunction
  let swapExact1For0: SwapFunction

  let feeAmount: number
  let tickSpacing: number

  let minTick: number
  let maxTick: number

  let mint: MintFunction

  let loadFixture: ReturnType<typeof createFixtureLoader>
  let createPool: any

  before('create fixture loader', async () => {
    ;[wallet, other] = await (ethers as any).getSigners()
    loadFixture = createFixtureLoader([wallet, other])
  })

  beforeEach('deploy fixture', async () => {
    ;({ token0, token1, token2, factory, createPool, swapTargetCallee: swapTarget } = await loadFixture(poolFixture))

    const oldCreatePool = createPool
    createPool = async (_feeAmount: number, _tickSpacing: number) => {
      const pool = await oldCreatePool(_feeAmount, _tickSpacing)
      ;({ swapExact0For1, swapExact1For0, mint } = createPoolFunctions({
        token0,
        token1,
        swapTarget,
        pool,
      }))
      minTick = getMinTick(_tickSpacing)
      maxTick = getMaxTick(_tickSpacing)
      feeAmount = _feeAmount
      tickSpacing = _tickSpacing
      return pool
    }

    pool = await createPool(FeeAmount.MEDIUM, TICK_SPACINGS[FeeAmount.MEDIUM])
  })

  describe('Virtual Reserves Formula (x_virtual * y_virtual = L²)', () => {
    describe('when price is within range', () => {
      beforeEach('initialize and add liquidity in range', async () => {
        await pool.initialize(encodePriceSqrt(1, 1))
      })

      it('verifies virtual reserves formula when price is within range', async () => {
        const liquidity = expandTo18Decimals(1)
        const lowerTick = -tickSpacing * 100
        const upperTick = tickSpacing * 100

        await mint(wallet.address, lowerTick, upperTick, liquidity)

        const { sqrtPriceX96, tick } = await pool.slot0()
        const currentLiquidity = await pool.liquidity()

        const sqrtLower = await getSqrtRatioAtTickViaContract(lowerTick)
        const sqrtUpper = await getSqrtRatioAtTickViaContract(upperTick)

        expect(tick).to.be.gte(lowerTick)
        expect(tick).to.be.lt(upperTick)
        expect(currentLiquidity).to.eq(liquidity)

        const poolBalance0 = await token0.balanceOf(pool.address)
        const poolBalance1 = await token1.balanceOf(pool.address)

        expect(poolBalance0).to.be.gt(0)
        expect(poolBalance1).to.be.gt(0)
      })

      it('verifies both tokens are needed when price is within range', async () => {
        const liquidity = expandTo18Decimals(1)
        const lowerTick = -tickSpacing * 100
        const upperTick = tickSpacing * 100

        const balance0Before = await token0.balanceOf(pool.address)
        const balance1Before = await token1.balanceOf(pool.address)

        await mint(wallet.address, lowerTick, upperTick, liquidity)

        const balance0After = await token0.balanceOf(pool.address)
        const balance1After = await token1.balanceOf(pool.address)

        expect(balance0After).to.be.gt(balance0Before)
        expect(balance1After).to.be.gt(balance1Before)
      })
    })

    describe('when liquidity is added above current price', () => {
      beforeEach('initialize pool', async () => {
        await pool.initialize(encodePriceSqrt(1, 1))
      })

      it('verifies only token0 is needed when liquidity is added above current price', async () => {
        const liquidity = expandTo18Decimals(1)
        const lowerTick = tickSpacing * 100
        const upperTick = tickSpacing * 200

        const balance0Before = await token0.balanceOf(pool.address)
        const balance1Before = await token1.balanceOf(pool.address)

        await mint(wallet.address, lowerTick, upperTick, liquidity)

        const balance0After = await token0.balanceOf(pool.address)
        const balance1After = await token1.balanceOf(pool.address)

        expect(balance0After).to.be.gt(balance0Before)
        expect(balance1After).to.eq(balance1Before)

        const { tick } = await pool.slot0()
        expect(tick).to.be.lt(lowerTick)
      })
    })

    describe('when liquidity is added below current price', () => {
      beforeEach('initialize pool', async () => {
        await pool.initialize(encodePriceSqrt(1, 1))
      })

      it('verifies only token1 is needed when liquidity is added below current price', async () => {
        const liquidity = expandTo18Decimals(1)
        const lowerTick = -tickSpacing * 200
        const upperTick = -tickSpacing * 100

        const balance0Before = await token0.balanceOf(pool.address)
        const balance1Before = await token1.balanceOf(pool.address)

        await mint(wallet.address, lowerTick, upperTick, liquidity)

        const balance0After = await token0.balanceOf(pool.address)
        const balance1After = await token1.balanceOf(pool.address)

        expect(balance0After).to.eq(balance0Before)
        expect(balance1After).to.be.gt(balance1Before)

        const { tick } = await pool.slot0()
        expect(tick).to.be.gte(upperTick)
      })
    })
  })

  describe('Liquidity Dynamics - Entering and Exiting Ranges', () => {
    beforeEach('initialize at zero tick with full range liquidity', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, expandTo18Decimals(2))
    })

    it('liquidity does not change when adding liquidity outside current range', async () => {
      const liquidityBefore = await pool.liquidity()

      const lowerTick = tickSpacing * 100
      const upperTick = tickSpacing * 200
      await mint(wallet.address, lowerTick, upperTick, expandTo18Decimals(1))

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter).to.eq(liquidityBefore)
    })

    it('liquidity increases when adding liquidity within current range', async () => {
      const liquidityBefore = await pool.liquidity()

      const lowerTick = -tickSpacing * 100
      const upperTick = tickSpacing * 100
      const additionalLiquidity = expandTo18Decimals(1)
      await mint(wallet.address, lowerTick, upperTick, additionalLiquidity)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter).to.eq(liquidityBefore.add(additionalLiquidity))
    })

    it('liquidity updates when price crosses a tick boundary (exiting range)', async () => {
      const kBefore = await pool.liquidity()

      const lowerTick = 0
      const upperTick = tickSpacing
      const liquidityDelta = expandTo18Decimals(1)
      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const kAfterMint = await pool.liquidity()
      expect(kAfterMint).to.eq(kBefore.add(liquidityDelta))

      await swapExact0For1(1, wallet.address)

      const { tick } = await pool.slot0()
      expect(tick).to.be.lt(0)

      const kAfterSwap = await pool.liquidity()
      expect(kAfterSwap).to.eq(kBefore)
    })

    it('liquidity updates when price crosses a tick boundary (entering range)', async () => {
      const kBefore = await pool.liquidity()

      const lowerTick = -tickSpacing
      const upperTick = 0
      const liquidityDelta = expandTo18Decimals(1)
      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const kAfterMint = await pool.liquidity()
      expect(kAfterMint).to.eq(kBefore)

      await swapExact0For1(1, wallet.address)

      const { tick } = await pool.slot0()
      expect(tick).to.be.lt(0)

      const kAfterSwap = await pool.liquidity()
      expect(kAfterSwap).to.eq(kBefore.add(liquidityDelta))
    })
  })

  describe('Tick Math and Price Relationships', () => {
    it('verifies getSqrtRatioAtTick returns correct values for boundary ticks (tickSpacing=1)', async () => {
      const TickMathTestFactory = await ethers.getContractFactory('TickMathTest')
      const tickMathTest = await TickMathTestFactory.deploy()

      const MIN_TICK = -887272
      const MAX_TICK = 887272

      const minSqrtRatio = await tickMathTest.getSqrtRatioAtTick(MIN_TICK)
      const maxSqrtRatio = await tickMathTest.getSqrtRatioAtTick(MAX_TICK)
      const maxSqrtRatioMinus1Tick = await tickMathTest.getSqrtRatioAtTick(MAX_TICK - 1)

      expect(minSqrtRatio).to.eq(MIN_SQRT_RATIO)
      expect(maxSqrtRatio).to.eq(MAX_SQRT_RATIO)
      expect(maxSqrtRatioMinus1Tick).to.be.lt(MAX_SQRT_RATIO)
    })

    it('verifies getTickAtSqrtRatio is inverse of getSqrtRatioAtTick', async () => {
      const TickMathTestFactory = await ethers.getContractFactory('TickMathTest')
      const tickMathTest = await TickMathTestFactory.deploy()

      const testTicks = [-10000, -1000, -100, 0, 100, 1000, 10000]

      for (const tick of testTicks) {
        const sqrtRatio = await tickMathTest.getSqrtRatioAtTick(tick)
        const tickBack = await tickMathTest.getTickAtSqrtRatio(sqrtRatio)
        expect(tickBack).to.eq(tick)
      }
    })

    it('verifies price increases as tick increases', async () => {
      const TickMathTestFactory = await ethers.getContractFactory('TickMathTest')
      const tickMathTest = await TickMathTestFactory.deploy()

      const sqrtRatio0 = await tickMathTest.getSqrtRatioAtTick(0)
      const sqrtRatio1 = await tickMathTest.getSqrtRatioAtTick(1)
      const sqrtRatioNeg1 = await tickMathTest.getSqrtRatioAtTick(-1)

      expect(sqrtRatio1).to.be.gt(sqrtRatio0)
      expect(sqrtRatio0).to.be.gt(sqrtRatioNeg1)
    })
  })

  describe('Concentrated Liquidity Efficiency', () => {
    beforeEach('initialize pool', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
    })

    it('narrower range requires less capital for same liquidity', async () => {
      const liquidity = expandTo18Decimals(1)

      const wideLower = -tickSpacing * 1000
      const wideUpper = tickSpacing * 1000

      const narrowLower = -tickSpacing * 10
      const narrowUpper = tickSpacing * 10

      await mint(wallet.address, wideLower, wideUpper, liquidity)
      const balance0Wide = await token0.balanceOf(pool.address)
      const balance1Wide = await token1.balanceOf(pool.address)

      pool = await createPool(FeeAmount.MEDIUM, TICK_SPACINGS[FeeAmount.MEDIUM])
      await pool.initialize(encodePriceSqrt(1, 1))

      await mint(wallet.address, narrowLower, narrowUpper, liquidity)
      const balance0Narrow = await token0.balanceOf(pool.address)
      const balance1Narrow = await token1.balanceOf(pool.address)

      expect(balance0Narrow).to.be.lt(balance0Wide)
      expect(balance1Narrow).to.be.lt(balance1Wide)
    })

    it('multiple LPs with overlapping ranges contribute to combined liquidity', async () => {
      const liquidity1 = expandTo18Decimals(1)
      const liquidity2 = expandTo18Decimals(2)

      await mint(wallet.address, -tickSpacing * 100, tickSpacing * 100, liquidity1)
      const liquidityAfterFirst = await pool.liquidity()
      expect(liquidityAfterFirst).to.eq(liquidity1)

      await mint(other.address, -tickSpacing * 50, tickSpacing * 50, liquidity2)
      const liquidityAfterSecond = await pool.liquidity()
      expect(liquidityAfterSecond).to.eq(liquidity1.add(liquidity2))
    })
  })

  describe('Virtual Reserves Mathematical Verification', () => {
    beforeEach('initialize pool at price 1:1', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
    })

    it('verifies getAmount0Delta and getAmount1Delta calculations match actual balances (within range)', async () => {
      const liquidity = expandTo18Decimals(1)
      const lowerTick = -tickSpacing * 100
      const upperTick = tickSpacing * 100

      const SqrtPriceMathTestFactory = await ethers.getContractFactory('SqrtPriceMathTest')
      const sqrtPriceMathTest = await SqrtPriceMathTestFactory.deploy()

      await mint(wallet.address, lowerTick, upperTick, liquidity)

      const { sqrtPriceX96 } = await pool.slot0()
      const currentLiquidity = await pool.liquidity()

      const sqrtLower = await getSqrtRatioAtTickViaContract(lowerTick)
      const sqrtUpper = await getSqrtRatioAtTickViaContract(upperTick)

      const amount0Delta = await sqrtPriceMathTest.getAmount0Delta(sqrtPriceX96, sqrtUpper, currentLiquidity, true)
      const amount1Delta = await sqrtPriceMathTest.getAmount1Delta(sqrtLower, sqrtPriceX96, currentLiquidity, true)

      const poolBalance0 = await token0.balanceOf(pool.address)
      const poolBalance1 = await token1.balanceOf(pool.address)

      expect(bnCloseTo(poolBalance0, amount0Delta, 100)).to.be.true
      expect(bnCloseTo(poolBalance1, amount1Delta, 100)).to.be.true
    })

    it('verifies token0 calculation when price is below range', async () => {
      const liquidity = expandTo18Decimals(1)
      const lowerTick = tickSpacing * 100
      const upperTick = tickSpacing * 200

      const SqrtPriceMathTestFactory = await ethers.getContractFactory('SqrtPriceMathTest')
      const sqrtPriceMathTest = await SqrtPriceMathTestFactory.deploy()

      const balance0Before = await token0.balanceOf(pool.address)
      await mint(wallet.address, lowerTick, upperTick, liquidity)
      const balance0After = await token0.balanceOf(pool.address)
      const token0Used = balance0After.sub(balance0Before)

      const sqrtLower = await getSqrtRatioAtTickViaContract(lowerTick)
      const sqrtUpper = await getSqrtRatioAtTickViaContract(upperTick)

      const expectedAmount0 = await sqrtPriceMathTest.getAmount0Delta(sqrtLower, sqrtUpper, liquidity, true)

      expect(bnCloseTo(token0Used, expectedAmount0, 100)).to.be.true
    })

    it('verifies token1 calculation when price is above range', async () => {
      const liquidity = expandTo18Decimals(1)
      const lowerTick = -tickSpacing * 200
      const upperTick = -tickSpacing * 100

      const SqrtPriceMathTestFactory = await ethers.getContractFactory('SqrtPriceMathTest')
      const sqrtPriceMathTest = await SqrtPriceMathTestFactory.deploy()

      const balance1Before = await token1.balanceOf(pool.address)
      await mint(wallet.address, lowerTick, upperTick, liquidity)
      const balance1After = await token1.balanceOf(pool.address)
      const token1Used = balance1After.sub(balance1Before)

      const sqrtLower = await getSqrtRatioAtTickViaContract(lowerTick)
      const sqrtUpper = await getSqrtRatioAtTickViaContract(upperTick)

      const expectedAmount1 = await sqrtPriceMathTest.getAmount1Delta(sqrtLower, sqrtUpper, liquidity, true)

      expect(bnCloseTo(token1Used, expectedAmount1, 100)).to.be.true
    })
  })

  describe('Core Formula: (x + L/√P_u) * (y + L*√P_l) = L² Concept', () => {
    beforeEach('initialize pool', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
    })

    it('demonstrates three scenarios of liquidity provision based on price position', async () => {
      const liquidity = expandTo18Decimals(10)

      const SqrtPriceMathTestFactory = await ethers.getContractFactory('SqrtPriceMathTest')
      const sqrtPriceMathTest = await SqrtPriceMathTestFactory.deploy()

      const { sqrtPriceX96: currentSqrtPrice } = await pool.slot0()

      const belowLower = -tickSpacing * 200
      const belowUpper = -tickSpacing * 100
      const aboveLower = tickSpacing * 100
      const aboveUpper = tickSpacing * 200
      const withinLower = -tickSpacing * 100
      const withinUpper = tickSpacing * 100

      const sqrtBelowLower = await getSqrtRatioAtTickViaContract(belowLower)
      const sqrtBelowUpper = await getSqrtRatioAtTickViaContract(belowUpper)
      const sqrtAboveLower = await getSqrtRatioAtTickViaContract(aboveLower)
      const sqrtAboveUpper = await getSqrtRatioAtTickViaContract(aboveUpper)
      const sqrtWithinLower = await getSqrtRatioAtTickViaContract(withinLower)
      const sqrtWithinUpper = await getSqrtRatioAtTickViaContract(withinUpper)

      const expectedToken1ForBelow = await sqrtPriceMathTest.getAmount1Delta(
        sqrtBelowLower,
        sqrtBelowUpper,
        liquidity,
        true
      )
      const expectedToken0ForAbove = await sqrtPriceMathTest.getAmount0Delta(
        sqrtAboveLower,
        sqrtAboveUpper,
        liquidity,
        true
      )
      const expectedToken0ForWithin = await sqrtPriceMathTest.getAmount0Delta(
        currentSqrtPrice,
        sqrtWithinUpper,
        liquidity,
        true
      )
      const expectedToken1ForWithin = await sqrtPriceMathTest.getAmount1Delta(
        sqrtWithinLower,
        currentSqrtPrice,
        liquidity,
        true
      )

      expect(expectedToken1ForBelow).to.be.gt(0)
      expect(expectedToken0ForAbove).to.be.gt(0)
      expect(expectedToken0ForWithin).to.be.gt(0)
      expect(expectedToken1ForWithin).to.be.gt(0)
    })

    it('validates that getAmount0Delta = L/√P_l - L/√P_u', async () => {
      const liquidity = expandTo18Decimals(10)
      const lowerTick = -tickSpacing * 100
      const upperTick = tickSpacing * 100

      const SqrtPriceMathTestFactory = await ethers.getContractFactory('SqrtPriceMathTest')
      const sqrtPriceMathTest = await SqrtPriceMathTestFactory.deploy()

      const sqrtLower = await getSqrtRatioAtTickViaContract(lowerTick)
      const sqrtUpper = await getSqrtRatioAtTickViaContract(upperTick)

      const amount0Delta = await sqrtPriceMathTest.getAmount0Delta(sqrtLower, sqrtUpper, liquidity, true)

      expect(amount0Delta).to.be.gt(0)
    })

    it('validates that getAmount1Delta = L*(√P_u - √P_l)', async () => {
      const liquidity = expandTo18Decimals(10)
      const lowerTick = -tickSpacing * 100
      const upperTick = tickSpacing * 100

      const SqrtPriceMathTestFactory = await ethers.getContractFactory('SqrtPriceMathTest')
      const sqrtPriceMathTest = await SqrtPriceMathTestFactory.deploy()

      const sqrtLower = await getSqrtRatioAtTickViaContract(lowerTick)
      const sqrtUpper = await getSqrtRatioAtTickViaContract(upperTick)

      const amount1Delta = await sqrtPriceMathTest.getAmount1Delta(sqrtLower, sqrtUpper, liquidity, true)

      expect(amount1Delta).to.be.gt(0)
    })
  })
})

async function getSqrtRatioAtTickViaContract(tick: number): Promise<BigNumber> {
  const TickMathTestFactory = await ethers.getContractFactory('TickMathTest')
  const tickMathTest = await TickMathTestFactory.deploy()
  return tickMathTest.getSqrtRatioAtTick(tick)
}
