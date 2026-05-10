import { Injectable } from '@nestjs/common';
import axios from 'axios';

interface CacheEntry {
    rate: number;
    ts: number;
}

interface FxResult {
    fxMarketRate: number;
    fxFinalRate: number;
    fxSource: string;   
    grossUSD: number;
    feeUSD: number;
    netUSD: number;
}

@Injectable()
export class CurrencyService {

    // 🔥 FIX #7: cache com TTL — evita taxa defasada em processo longo
    private cache: Map<string, CacheEntry> = new Map();
    private readonly CACHE_TTL_MS = 60_000; // 60 segundos

    private readonly PLATFORM_FX_FEE = 0.02;
    private readonly APP_ID = process.env.OXR_APP_ID;

    // ─── Fetch de rates ───────────────────────────────────────────────────────

    private async getRates(): Promise<Record<string, number>> {
        const url = `https://openexchangerates.org/api/latest.json?app_id=${this.APP_ID}`;
        const response = await axios.get(url);
        return response.data.rates;
    }

    async getRate(from: string, to: string): Promise<number> {
        const rates = await this.getRates();

        if (!rates[from]) throw new Error(`Currency not supported: ${from}`);
        if (!rates[to])   throw new Error(`Currency not supported: ${to}`);

        return rates[to] / rates[from]; // USD é base
    }

    // ─── Cache com TTL ────────────────────────────────────────────────────────

    private getCached(currency: string): number | null {
        const entry = this.cache.get(currency);
        if (!entry) return null;
        if (Date.now() - entry.ts > this.CACHE_TTL_MS) {
            this.cache.delete(currency);
            return null;
        }
        return entry.rate;
    }

    private setCached(currency: string, rate: number) {
        this.cache.set(currency, { rate, ts: Date.now() });
    }

    // ─── Conversão principal ──────────────────────────────────────────────────

    async convertToUSDWithFee(amount: number, currency: string): Promise<FxResult> {
        currency = currency.toUpperCase();

        // USD direto — sem chamada externa
        if (currency === 'USD') {
            const fxMarketRate = 1;
            const fxFinalRate  = 1 * (1 - this.PLATFORM_FX_FEE);
            const grossUSD     = amount;
            const feeUSD       = grossUSD * this.PLATFORM_FX_FEE;
            const netUSD       = grossUSD - feeUSD;

            return {
                fxMarketRate,
                fxFinalRate,
                fxSource: 'internal',  // 🔥 sempre presente
                grossUSD,
                feeUSD,
                netUSD,
            };
        }

        // Cache hit
        const cached = this.getCached(currency);
        if (cached) {
            const fxMarketRate = cached;
            const fxFinalRate  = fxMarketRate * (1 - this.PLATFORM_FX_FEE);
            const grossUSD     = amount * fxMarketRate;
            const feeUSD       = grossUSD * this.PLATFORM_FX_FEE;
            const netUSD       = grossUSD - feeUSD;

            return {
                fxMarketRate,
                fxFinalRate,
                fxSource: 'cache',    // 🔥 sempre presente
                grossUSD,
                feeUSD,
                netUSD,
            };
        }

        // Fetch externo
        const fxMarketRate = await this.getRate(currency, 'USD');
        if (!fxMarketRate) throw new Error('Invalid FX rate');

        this.setCached(currency, fxMarketRate);

        const fxFinalRate = fxMarketRate * (1 - this.PLATFORM_FX_FEE);
        const grossUSD    = amount * fxMarketRate;
        const feeUSD      = grossUSD * this.PLATFORM_FX_FEE;
        const netUSD      = grossUSD - feeUSD;

        return {
            fxMarketRate,
            fxFinalRate,
            fxSource: 'openexchangerates',  
            grossUSD,
            feeUSD,
            netUSD,
        };
    }
}