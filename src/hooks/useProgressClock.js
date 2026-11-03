import { useEffect, useState } from 'react';

// One interval for a status card's clocks, alive only while there is a clock to
// update. It cannot outlive the component.
export function useProgressClock(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
