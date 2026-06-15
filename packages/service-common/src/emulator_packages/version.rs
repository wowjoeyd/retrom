use std::cmp::Ordering;

/// Compare two emulator package version strings for "newer" ordering.
pub fn compare_package_versions(a: &str, b: &str) -> Ordering {
    match (parse_sort_key(a), parse_sort_key(b)) {
        (Some(ka), Some(kb)) => ka.cmp(&kb),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => a.cmp(b),
    }
}

fn parse_sort_key(version: &str) -> Option<(u64, u64, u64, u64)> {
    let normalized = version.strip_prefix('v').unwrap_or(version);
    let (semver_part, build_suffix) = match normalized.split_once('-') {
        Some((left, right)) if left.chars().filter(|c| *c == '.').count() >= 1 => (left, right),
        _ => (normalized, ""),
    };

    let mut nums = semver_part
        .split('.')
        .filter_map(|part| part.parse::<u64>().ok())
        .collect::<Vec<_>>();

    while nums.len() < 3 {
        nums.push(0);
    }

    let build = build_suffix
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse::<u64>()
        .unwrap_or(0);

    Some((nums[0], nums[1], nums[2], build))
}

#[cfg(test)]
mod tests {
    use super::compare_package_versions;
    use std::cmp::Ordering;

    #[test]
    fn compares_rpcs3_style_tags() {
        assert_eq!(
            compare_package_versions("0.0.34-17089", "0.0.33-17000"),
            Ordering::Greater
        );
    }

    #[test]
    fn compares_prefixed_semver() {
        assert_eq!(
            compare_package_versions("v2.0.2", "v2.0.1"),
            Ordering::Greater
        );
    }
}
