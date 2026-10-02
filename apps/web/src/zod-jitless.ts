// The page's CSP forbids eval. Zod probes for it with `new Function("")` when the first object schema is built, and the
// browser logs the refused probe as a CSP error on every load. Jitless skips the probe, so this must be main.tsx's first import.
import { z } from "zod";

z.config({ jitless: true });
