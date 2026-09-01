/**
 * The children the launcher owns, in the order they are started.
 *
 * Stopping is the exact reverse (the supervisor stops in reverse start order):
 * the connector has to stop dialing before the relay it dials goes away, and
 * dsh outlives both of its clients so neither loses its upstream mid-request.
 */
export const CHILD_START_ORDER = ['dsh', 'relay', 'connector'] as const

/** Name of one supervised child, as it appears in log prefixes and messages. */
export type LauncherChildName = typeof CHILD_START_ORDER[number]

export const [DSH_CHILD, RELAY_CHILD, CONNECTOR_CHILD] = CHILD_START_ORDER
