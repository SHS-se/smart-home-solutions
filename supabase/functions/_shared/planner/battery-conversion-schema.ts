import { z } from 'zod';
import { validConversion, type Conversion } from './battery-conversion.ts';

/** Transport owns package validation; device physics stays dependency-free. */
export const conversionSchema = z.custom<Conversion>(validConversion, 'Explicit directional conversion and installation-loss model required');
