import { CronExpressionParser } from "cron-parser";

export function nextCronTime(expression: string, timezone: string, after: number): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[0-9*/,-]+$/.test(field))) {
    throw new Error("Enter five numeric cron fields for minute, hour, day, month and weekday.");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after);
  } catch {
    throw new Error("Choose a valid time zone.");
  }
  try {
    return CronExpressionParser.parse(expression, { currentDate: after, tz: timezone }).next().getTime();
  } catch {
    throw new Error("This cron expression has no valid next run.");
  }
}
