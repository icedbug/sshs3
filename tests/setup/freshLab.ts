import { afterEach } from "vitest";
import { resetLabForTesting } from "../../src/main/sim/SimWorld";

/**
 * The demo lab's simulated servers are one set for the whole process, and a hub in demo mode builds the
 * always-there ones (the base fleet) when it starts. Without this, a test would begin with the servers
 * an earlier test of the same file left behind, in the state that test put them in.
 *
 * After every test: no incident's lab, no base fleet, and the fleet switched on again for the next one.
 */
afterEach(() => resetLabForTesting());
