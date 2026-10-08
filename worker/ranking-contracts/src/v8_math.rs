// Adapted from Node v24.21.0 deps/v8/src/base/ieee754.cc, exp and log.
// Evaluation order and binary64 constants must stay unchanged for parity.
//
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved.
//
// The original source was modified significantly by Google Inc.
// Copyright 2016 the V8 project authors. All rights reserved.
// V8's BSD license is reproduced in worker/THIRD_PARTY_NOTICES.md.

const LN2_HI: f64 = f64::from_bits(0x3fe62e42fee00000);
const LN2_LO: f64 = f64::from_bits(0x3dea39ef35793c76);

fn high(value: f64) -> u32 {
    (value.to_bits() >> 32) as u32
}

fn with_high(value: f64, word: u32) -> f64 {
    f64::from_bits((u64::from(word) << 32) | (value.to_bits() & 0xffffffff))
}

pub fn exp(mut x: f64) -> f64 {
    const INV_LN2: f64 = f64::from_bits(0x3ff71547652b82fe);
    const P1: f64 = f64::from_bits(0x3fc555555555553e);
    const P2: f64 = f64::from_bits(0xbf66c16c16bebd93);
    const P3: f64 = f64::from_bits(0x3f11566aaf25de2c);
    const P4: f64 = f64::from_bits(0xbebbbd41c5d26bf1);
    const P5: f64 = f64::from_bits(0x3e66376972bea4d0);
    let word = high(x);
    let sign = (word >> 31) as usize;
    let hx = word & 0x7fffffff;
    if hx >= 0x40862e42 {
        if hx >= 0x7ff00000 {
            return if x.is_nan() {
                x + x
            } else if sign == 0 {
                x
            } else {
                0.0
            };
        }
        if x > f64::from_bits(0x40862e42fefa39ef) {
            return f64::INFINITY;
        }
        if x < f64::from_bits(0xc0874910d52d3051) {
            return 0.0;
        }
    }
    let mut hi = 0.0;
    let mut lo = 0.0;
    let mut k: i32 = 0;
    if hx > 0x3fd62e42 {
        if hx < 0x3ff0a2b2 {
            if x == 1.0 {
                return f64::from_bits(0x4005bf0a8b145769);
            }
            hi = x - [LN2_HI, -LN2_HI][sign];
            lo = [LN2_LO, -LN2_LO][sign];
            k = 1 - 2 * sign as i32;
        } else {
            k = (INV_LN2 * x + [0.5, -0.5][sign]) as i32;
            let t = f64::from(k);
            hi = x - t * LN2_HI;
            lo = t * LN2_LO;
        }
        x = hi - lo;
    } else if hx < 0x3e300000 {
        return 1.0 + x;
    }
    let t = x * x;
    let power = if k >= -1021 {
        f64::from_bits(u64::from(0x3ff00000u32.wrapping_add((k as u32) << 20)) << 32)
    } else {
        f64::from_bits(u64::from(0x3ff00000u32.wrapping_add(((k + 1000) as u32) << 20)) << 32)
    };
    let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0 {
        return 1.0 - ((x * c) / (c - 2.0) - x);
    }
    let y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        if k == 1024 {
            y * 2.0 * f64::from_bits(0x7fe0000000000000)
        } else {
            y * power
        }
    } else {
        y * power * f64::from_bits(0x0170000000000000)
    }
}

pub fn log(mut x: f64) -> f64 {
    const LG1: f64 = f64::from_bits(0x3fe5555555555593);
    const LG2: f64 = f64::from_bits(0x3fd999999997fa04);
    const LG3: f64 = f64::from_bits(0x3fd2492494229359);
    const LG4: f64 = f64::from_bits(0x3fcc71c51d8e78af);
    const LG5: f64 = f64::from_bits(0x3fc7466496cb03de);
    const LG6: f64 = f64::from_bits(0x3fc39a09d078c69f);
    const LG7: f64 = f64::from_bits(0x3fc2f112df3e5244);
    let mut hx = high(x) as i32;
    let low = x.to_bits() as u32;
    let mut k: i32 = 0;
    if hx < 0x00100000 {
        if ((hx as u32 & 0x7fffffff) | low) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= f64::from_bits(0x4350000000000000);
        hx = high(x) as i32;
    }
    if hx >= 0x7ff00000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    let mut i = (hx + 0x95f64) & 0x100000;
    x = with_high(x, (hx | (i ^ 0x3ff00000)) as u32);
    k += i >> 20;
    let f = x - 1.0;
    if (0x000fffff & (2 + hx)) < 3 {
        if f == 0.0 {
            return if k == 0 {
                0.0
            } else {
                f64::from(k) * LN2_HI + f64::from(k) * LN2_LO
            };
        }
        let r = f * f * (0.5 - f64::from_bits(0x3fd5555555555555) * f);
        return if k == 0 {
            f - r
        } else {
            f64::from(k) * LN2_HI - ((r - f64::from(k) * LN2_LO) - f)
        };
    }
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}
