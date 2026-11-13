import { Ghost } from "lucide-react";
import { motion } from "motion/react";
import { short } from "./lib.ts";

/** You → a fresh one-time address → them. The one memorable picture of what Ghost Paths does. */
export function GhostPath({
  from,
  to,
  address,
  lit,
}: { from: string; to: string; address?: string; lit?: boolean }) {
  const draw = (delay: number) =>
    lit
      ? {
          initial: { pathLength: 0 },
          animate: { pathLength: 1 },
          transition: { duration: 0.6, delay, ease: "easeInOut" as const },
        }
      : {};
  return (
    <div className="path" aria-hidden="true">
      <div className="node">
        <div className="disc you">{from.slice(0, 1).toUpperCase() || "?"}</div>
        <div className="cap">
          <b>{from || "You"}</b>pays
        </div>
      </div>
      <svg className="trail" viewBox="0 0 100 12" preserveAspectRatio="none">
        <title>path</title>
        <line x1="2" y1="6" x2="98" y2="6" />
        {lit && <motion.line x1="2" y1="6" x2="98" y2="6" className="on" {...draw(0)} />}
      </svg>
      <div className="node">
        <motion.div
          className={`disc ghost ${lit ? "lit" : ""}`}
          animate={lit ? { scale: [1, 1.12, 1] } : {}}
          transition={{ duration: 0.5, delay: 0.55 }}
        >
          <Ghost size={22} />
        </motion.div>
        <div className="cap">
          <b>{address ? short(address, 6, 4) : "New address"}</b>used once
        </div>
      </div>
      <svg className="trail" viewBox="0 0 100 12" preserveAspectRatio="none">
        <title>path</title>
        <line x1="2" y1="6" x2="98" y2="6" />
        {lit && <motion.line x1="2" y1="6" x2="98" y2="6" className="on" {...draw(0.7)} />}
      </svg>
      <div className="node">
        <div className="disc them">{to.slice(0, 1).toUpperCase() || "?"}</div>
        <div className="cap">
          <b>{to || "Them"}</b>receives
        </div>
      </div>
    </div>
  );
}
