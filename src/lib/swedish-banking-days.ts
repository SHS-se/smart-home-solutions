/**
 * Swedish banking day utilities
 * 
 * Calculates banking days avoiding:
 * - Weekends (Saturday, Sunday)
 * - Swedish public holidays (röda dagar)
 */

import { isPublicHoliday } from 'swedish-holidays';

/**
 * Check if a date is a Swedish banking day
 * (not a weekend and not a public holiday)
 */
export function isBankingDay(date: Date): boolean {
  const dayOfWeek = date.getDay();
  
  // Saturday (6) or Sunday (0) are not banking days
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return false;
  }
  
  // Check if it's a Swedish public holiday (röd dag)
  if (isPublicHoliday(date)) {
    return false;
  }
  
  return true;
}

/**
 * Get the next banking day from a given date
 * If the date is already a banking day, returns the same date
 */
export function getNextBankingDay(date: Date): Date {
  const result = new Date(date);
  
  while (!isBankingDay(result)) {
    result.setDate(result.getDate() + 1);
  }
  
  return result;
}

/**
 * Add a number of calendar days to a date and return the next banking day
 * If the resulting date falls on a weekend or holiday, returns the next banking day
 */
export function addDaysAndGetBankingDay(daysToAdd: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + daysToAdd);
  
  return getNextBankingDay(date);
}

/**
 * Get the default invoice due date (14 days from now, adjusted to next banking day)
 * Returns in YYYY-MM-DD format
 */
export function getDefaultInvoiceDueDate(): string {
  const dueDate = addDaysAndGetBankingDay(14);
  return dueDate.toISOString().split('T')[0];
}
