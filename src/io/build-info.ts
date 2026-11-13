/** Source revision and numerics hash stamped in at build time; `dev` outside a stamped build. */
export const BUILD_COMMIT: string = import.meta.env.VITE_COMMIT ?? 'dev';
export const BUILD_NUMERICS_HASH: string = import.meta.env.VITE_NUMERICS_HASH ?? 'dev';
