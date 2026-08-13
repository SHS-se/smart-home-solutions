import { supabase } from '@/integrations/supabase/client';
import {
  declaredWeightingFactor,
  type ParsedEnergyDeclaration,
} from './energy-declaration-parser';
import {
  ELECTRICITY_WEIGHTING_FACTOR,
  restatePrimaryEnergy,
} from './energiprestanda';

export class EnergyDeclarationImportError extends Error {
  readonly code: 'duplicate' | 'not_importable' | 'failed';

  constructor(code: EnergyDeclarationImportError['code'], message: string) {
    super(message);
    this.name = 'EnergyDeclarationImportError';
    this.code = code;
  }
}

export interface StoredEnergyDeclaration {
  id: string;
  declarationId: string | null;
  issuedOn: string | null;
  validUntil: string | null;
  primaryEnergyKwhM2: number;
  energyClass: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  newBuildRequirementKwhM2: number | null;
  similarBuildingsKwhM2: number | null;
  specificEnergyKwhM2: number | null;
  atempM2: number | null;
  yearBuilt: number | null;
  heatingSystem: string | null;
  municipality: string | null;
  buildingEnergyKwhPerYear: number | null;
  weightingFactor: number | null;
  measurementPeriodStart: string | null;
  measurementPeriodEnd: string | null;
  originalFileName: string;
}

/**
 * The certificate's number restated onto today's weighting factor.
 *
 * Without this a 2019 certificate and a 2026 calculation cannot be compared:
 * BBR 29 raised the electricity factor from 1.6 to 1.8 on 2020-09-01, so the
 * same building with the same energy use scores 12.5% higher today. Prefer the
 * factor the document itself implies; fall back to the issue date.
 */
export function restatedPrimaryEnergy(
  declaration: Pick<StoredEnergyDeclaration, 'primaryEnergyKwhM2' | 'weightingFactor' | 'issuedOn'>,
): number {
  const { primaryEnergyKwhM2, weightingFactor, issuedOn } = declaration;
  if (weightingFactor !== null && weightingFactor > 0) {
    return (primaryEnergyKwhM2 / weightingFactor) * ELECTRICITY_WEIGHTING_FACTOR;
  }
  if (issuedOn !== null) return restatePrimaryEnergy(primaryEnergyKwhM2, issuedOn);
  return primaryEnergyKwhM2;
}

/** True when restating actually changes the figure enough to be worth saying. */
export function wasRestated(
  declaration: Pick<StoredEnergyDeclaration, 'primaryEnergyKwhM2' | 'weightingFactor' | 'issuedOn'>,
): boolean {
  return Math.abs(restatedPrimaryEnergy(declaration) - declaration.primaryEnergyKwhM2) > 0.05;
}

export async function storeEnergyDeclaration(input: {
  customerId: string;
  homeId?: string | null;
  parsed: ParsedEnergyDeclaration;
  documentSha256: string;
  originalFileName: string;
}): Promise<string> {
  const { customerId, homeId = null, parsed, documentSha256, originalFileName } = input;
  if (!parsed.importable) {
    throw new EnergyDeclarationImportError(
      'not_importable',
      `Declaration parser rejected the file: ${parsed.errors.join(', ') || 'unknown_format'}`,
    );
  }

  const { data, error } = await supabase.rpc('create_energy_declaration', {
    p_customer_id: customerId,
    p_declaration: {
      home_id: homeId,
      declaration_id: parsed.declarationId,
      issued_on: parsed.issuedOn,
      valid_until: parsed.validUntil,
      primary_energy_kwh_m2: parsed.primaryEnergyKwhM2,
      energy_class: parsed.energyClass,
      new_build_requirement_kwh_m2: parsed.newBuildRequirementKwhM2,
      similar_buildings_kwh_m2: parsed.similarBuildingsKwhM2,
      specific_energy_kwh_m2: parsed.specificEnergyKwhM2,
      atemp_m2: parsed.atempM2,
      year_built: parsed.yearBuilt,
      heating_system: parsed.heatingSystem,
      municipality: parsed.municipality,
      ventilation_type: parsed.ventilationType,
      building_energy_kwh_per_year: parsed.buildingEnergyKwhPerYear,
      primary_energy_kwh_per_year: parsed.primaryEnergyKwhPerYear,
      weighting_factor: declaredWeightingFactor(parsed),
      posts_kwh: parsed.postsKwh,
      measurement_period_start: parsed.measurementPeriodStart,
      measurement_period_end: parsed.measurementPeriodEnd,
      parser_version: 1,
      document_sha256: documentSha256,
      original_file_name: originalFileName,
    },
  });

  if (error) {
    if (error.code === '23505') {
      throw new EnergyDeclarationImportError('duplicate', 'Already imported.');
    }
    throw new EnergyDeclarationImportError('failed', error.message);
  }
  return data as string;
}

/** The most recent certificate for a customer, or null. */
export async function fetchLatestEnergyDeclaration(
  customerId: string,
): Promise<StoredEnergyDeclaration | null> {
  const { data, error } = await supabase
    .from('energy_declarations')
    .select('id, declaration_id, issued_on, valid_until, primary_energy_kwh_m2, energy_class, new_build_requirement_kwh_m2, similar_buildings_kwh_m2, specific_energy_kwh_m2, atemp_m2, year_built, heating_system, municipality, building_energy_kwh_per_year, weighting_factor, measurement_period_start, measurement_period_end, original_file_name')
    .eq('customer_id', customerId)
    .order('issued_on', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id,
    declarationId: data.declaration_id,
    issuedOn: data.issued_on,
    validUntil: data.valid_until,
    primaryEnergyKwhM2: Number(data.primary_energy_kwh_m2),
    energyClass: data.energy_class as StoredEnergyDeclaration['energyClass'],
    newBuildRequirementKwhM2: data.new_build_requirement_kwh_m2 === null
      ? null
      : Number(data.new_build_requirement_kwh_m2),
    similarBuildingsKwhM2: data.similar_buildings_kwh_m2 === null
      ? null
      : Number(data.similar_buildings_kwh_m2),
    specificEnergyKwhM2: data.specific_energy_kwh_m2 === null
      ? null
      : Number(data.specific_energy_kwh_m2),
    atempM2: data.atemp_m2 === null ? null : Number(data.atemp_m2),
    yearBuilt: data.year_built,
    heatingSystem: data.heating_system,
    municipality: data.municipality,
    buildingEnergyKwhPerYear: data.building_energy_kwh_per_year === null
      ? null
      : Number(data.building_energy_kwh_per_year),
    weightingFactor: data.weighting_factor === null ? null : Number(data.weighting_factor),
    measurementPeriodStart: data.measurement_period_start,
    measurementPeriodEnd: data.measurement_period_end,
    originalFileName: data.original_file_name,
  };
}
