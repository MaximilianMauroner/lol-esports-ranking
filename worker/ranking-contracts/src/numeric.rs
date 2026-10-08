use crate::Result;

pub fn number_text(value: f64) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    ryu_js::Buffer::new().format_finite(value).to_owned()
}

pub fn to_fixed(value: f64, digits: u8) -> Result<String> {
    if digits > 100 {
        return Err("toFixed digits must be between 0 and 100".into());
    }
    Ok(ryu_js::Buffer::new()
        .format_to_fixed(value, digits)
        .to_owned())
}

pub fn js_round(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 || value.abs() >= 4503599627370496.0 {
        return value;
    }
    if (-0.5..0.0).contains(&value) {
        return -0.0;
    }
    let floor = value.floor();
    if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }
}

pub fn js_exp(value: f64) -> f64 {
    crate::v8_math::exp(value)
}
pub fn js_log(value: f64) -> f64 {
    crate::v8_math::log(value)
}
pub fn js_pow(base: f64, exponent: f64) -> f64 {
    // Node 24 enables V8's use_std_math_pow. Match its ECMAScript exceptions
    // and optimizer shortcuts before calling the platform's pow.
    if exponent.is_nan() {
        return f64::NAN;
    }
    if exponent == 0.0 {
        return 1.0;
    }
    if base.abs() == 1.0 && !exponent.is_finite() {
        return f64::NAN;
    }
    if exponent == 2.0 {
        return base * base;
    }
    if exponent == 0.5 {
        return if base.is_infinite() {
            f64::INFINITY
        } else {
            (base + 0.0).sqrt()
        };
    }
    base.powf(exponent)
}
