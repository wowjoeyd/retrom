use serde::{
    de::{self, Visitor},
    Deserializer,
};

struct StringifiedEmulatorPackageStatusVisitor;

impl Visitor<'_> for StringifiedEmulatorPackageStatusVisitor {
    type Value = i32;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("an integer or name representing an EmulatorPackageStatus")
    }

    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        match v {
            "Healthy" | "HEALTHY" | "EMULATOR_PACKAGE_STATUS_HEALTHY" => {
                Ok(crate::retrom::EmulatorPackageStatus::Healthy as i32)
            }
            "Degraded" | "DEGRADED" | "EMULATOR_PACKAGE_STATUS_DEGRADED" => {
                Ok(crate::retrom::EmulatorPackageStatus::Degraded as i32)
            }
            "Missing" | "MISSING" | "EMULATOR_PACKAGE_STATUS_MISSING" => {
                Ok(crate::retrom::EmulatorPackageStatus::Missing as i32)
            }
            _ => Err(de::Error::unknown_variant(
                v,
                &["Healthy", "Degraded", "Missing"],
            )),
        }
    }

    fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(v as i32)
    }
}

pub fn deserialize<'de, D>(deserializer: D) -> Result<i32, D::Error>
where
    D: Deserializer<'de>,
{
    deserializer.deserialize_any(StringifiedEmulatorPackageStatusVisitor)
}
