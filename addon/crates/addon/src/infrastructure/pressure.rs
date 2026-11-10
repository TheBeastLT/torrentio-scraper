use std::collections::VecDeque;

const WINDOW_MS: u64 = 2 * 60 * 1000;
const HISTORY_MS: u64 = 2 * WINDOW_MS;
const HOLD_MS: u64 = 30 * 60 * 1000;
const QUIET_MS: u64 = 10 * 60 * 1000;
const QUIET_FACTOR: f64 = 0.5;

#[derive(Clone, Copy, Debug)]
pub struct Reading {
    pub rate: f64,
    pub threshold: f64,
    pub active: bool,
}

#[derive(Clone, Copy)]
enum Status {
    Calm,
    Pressured { since: u64, quiet_since: Option<u64> },
}

pub struct Pressure {
    floor: f64,
    samples: VecDeque<(u64, f64)>,
    status: Status,
}

impl Pressure {
    pub fn new(floor: f64) -> Self {
        Self { floor, samples: VecDeque::new(), status: Status::Calm }
    }

    pub fn observe(&mut self, now: u64, misses: f64, forced: Option<bool>) -> Reading {
        self.samples.push_back((now, misses));
        while self.samples.front().is_some_and(|(at, _)| now.saturating_sub(*at) > HISTORY_MS) {
            self.samples.pop_front();
        }
        let rate = self.rate(now.saturating_sub(WINDOW_MS));
        self.status = match self.status {
            _ if forced == Some(false) => Status::Calm,
            Status::Calm if forced.unwrap_or(rate > self.floor) => Status::Pressured { since: now, quiet_since: None },
            Status::Calm => Status::Calm,
            Status::Pressured { since, quiet_since } => {
                let quiet_since = (rate < self.floor * QUIET_FACTOR).then(|| quiet_since.unwrap_or(now));
                let held = now.saturating_sub(since) < HOLD_MS;
                let quiet = quiet_since.is_some_and(|at| now.saturating_sub(at) >= QUIET_MS);
                if forced.is_none() && !held && quiet { Status::Calm } else { Status::Pressured { since, quiet_since } }
            }
        };
        Reading { rate, threshold: self.floor, active: matches!(self.status, Status::Pressured { .. }) }
    }

    fn rate(&self, from: u64) -> f64 {
        let Some((latest_at, latest)) = self.samples.back() else {
            return 0.0;
        };
        self.samples
            .iter()
            .rev()
            .find(|(at, _)| *at <= from)
            .map_or(0.0, |(at, count)| (latest - count) * 1000.0 / (latest_at - at) as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEP_MS: u64 = 30_000;

    struct Clock {
        pressure: Pressure,
        now: u64,
        misses: f64,
    }

    impl Clock {
        fn new(floor: f64) -> Self {
            Self { pressure: Pressure::new(floor), now: 0, misses: 0.0 }
        }

        fn run(&mut self, rate: f64, minutes: u64) -> Reading {
            let mut reading = Reading { rate: 0.0, threshold: 0.0, active: false };
            for _ in 0..minutes * 2 {
                self.now += STEP_MS;
                self.misses += rate * 30.0;
                reading = self.pressure.observe(self.now, self.misses, None);
            }
            reading
        }
    }

    #[test]
    fn stays_calm_below_the_floor() {
        let mut clock = Clock::new(100.0);
        clock.run(10.0, 10);
        assert!(!clock.run(90.0, 5).active);
    }

    #[test]
    fn trips_above_the_floor() {
        let mut clock = Clock::new(100.0);
        clock.run(20.0, 10);
        let reading = clock.run(400.0, 3);
        assert!(reading.active);
        assert!((reading.threshold - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn needs_a_full_window_before_tripping() {
        let mut clock = Clock::new(100.0);
        assert!(!clock.run(400.0, 1).active);
        assert!(clock.run(400.0, 2).active);
    }

    #[test]
    fn holds_for_thirty_minutes_after_tripping() {
        let mut clock = Clock::new(100.0);
        clock.run(400.0, 3);
        assert!(clock.run(0.0, 29).active);
    }

    #[test]
    fn releases_after_the_hold_once_quiet() {
        let mut clock = Clock::new(100.0);
        clock.run(400.0, 3);
        assert!(!clock.run(0.0, 31).active);
    }

    #[test]
    fn keeps_holding_while_the_rate_stays_high() {
        let mut clock = Clock::new(100.0);
        clock.run(400.0, 3);
        assert!(clock.run(400.0, 50).active);
    }

    #[test]
    fn release_waits_for_ten_quiet_minutes() {
        let mut clock = Clock::new(100.0);
        clock.run(400.0, 3);
        clock.run(400.0, 30);
        assert!(clock.run(0.0, 9).active);
        assert!(!clock.run(0.0, 3).active);
    }

    #[test]
    fn backward_clock_step_keeps_the_hold() {
        let mut clock = Clock::new(100.0);
        clock.run(400.0, 3);
        let earlier = clock.now - 2 * STEP_MS;
        assert!(clock.pressure.observe(earlier, clock.misses, None).active);
        assert!(clock.pressure.observe(earlier + STEP_MS, clock.misses, None).active);
    }

    #[test]
    fn override_forces_pressure_on() {
        let mut pressure = Pressure::new(100.0);
        assert!(pressure.observe(1, 0.0, Some(true)).active);
        assert!(pressure.observe(2, 0.0, None).active);
    }

    #[test]
    fn override_forces_pressure_off() {
        let mut clock = Clock::new(100.0);
        clock.run(400.0, 3);
        assert!(!clock.pressure.observe(clock.now + STEP_MS, clock.misses, Some(false)).active);
    }
}
