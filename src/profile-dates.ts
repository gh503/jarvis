export interface Birthday {
  calendar: 'solar' | 'lunar';
  year?: number;
  month: number;
  day: number;
  leap?: boolean;
}

export interface BirthdayDerived {
  age?: number;
  zodiac?: string;
  sunSign?: string;
  /** Missing prerequisites, runtime limitations, and the sun-sign approximation. */
  unsupported?: string;
}

type CivilDate = { year: number; month: number; day: number };
const DAY = 86_400_000;
const ANIMALS = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
const APPROXIMATE = '星座按常用公历月日区间估算，未计算出生时刻的太阳位置，交界日可能有差异。';
const CALENDAR_UNAVAILABLE = '当前运行环境不支持可靠的中国农历换算。';
const lunarYears = new Map<number, Map<string, CivilDate>>();

function chineseFormatter(): Intl.DateTimeFormat {
  const formatter = new Intl.DateTimeFormat('en-u-ca-chinese', {
    year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai',
  });
  if (formatter.resolvedOptions().calendar !== 'chinese') throw new Error(CALENDAR_UNAVAILABLE);
  return formatter;
}

function chineseParts(formatter: Intl.DateTimeFormat, date: Date): CivilDate & { leap: boolean } {
  const parts = formatter.formatToParts(date);
  const year = Number(parts.find(part => String(part.type) === 'relatedYear')?.value);
  const monthText = parts.find(part => part.type === 'month')?.value ?? '';
  const monthMatch = /^(\d{1,2})(bis)?$/.exec(monthText);
  const day = Number(parts.find(part => part.type === 'day')?.value);
  if (!Number.isInteger(year) || !monthMatch || !Number.isInteger(day) || day < 1 || day > 30) {
    throw new Error(CALENDAR_UNAVAILABLE);
  }
  const month = Number(monthMatch[1]);
  if (month < 1 || month > 12) throw new Error(CALENDAR_UNAVAILABLE);
  return { year, month, day, leap: Boolean(monthMatch[2]) };
}

function lunarToSolar(value: Birthday & { year: number }): CivilDate | undefined {
  let dates = lunarYears.get(value.year);
  if (!dates) {
    const formatter = chineseFormatter();
    dates = new Map();
    // Noon UTC is still the same civil date in Shanghai. Search includes lunar December.
    for (let time = Date.UTC(value.year, 0, 1, 12); time <= Date.UTC(value.year + 1, 2, 31, 12); time += DAY) {
      const date = new Date(time);
      const lunar = chineseParts(formatter, date);
      if (lunar.year === value.year) dates.set(`${lunar.month}/${lunar.day}/${lunar.leap}`, {
        year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
      });
    }
    // Bound memory even when called repeatedly with arbitrary user input.
    if (lunarYears.size >= 16) lunarYears.delete(lunarYears.keys().next().value!);
    lunarYears.set(value.year, dates);
  }
  return dates.get(`${value.month}/${value.day}/${value.leap === true}`);
}

function today(now: Date): CivilDate {
  const shanghai = new Date(now.getTime() + 8 * 3_600_000);
  return { year: shanghai.getUTCFullYear(), month: shanghai.getUTCMonth() + 1, day: shanghai.getUTCDate() };
}
function dateNumber(date: CivilDate): number { return date.year * 10_000 + date.month * 100 + date.day; }
function daysInMonth(year: number, month: number): number { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

/** A missing year is valid; missing month/day is incomplete. Errors are safe to display in the form. */
export function validateBirthday(value: unknown, now: Date = new Date()): string | undefined {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return '当前日期无效。';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '生日信息不完整，请填写历法、月份和日期。';
  const birthday = value as Birthday;
  if (birthday.calendar !== 'solar' && birthday.calendar !== 'lunar') return '请选择公历或农历。';
  if (birthday.month === undefined || birthday.day === undefined) return '生日信息不完整，请填写月份和日期；年份可以留空。';
  if (!Number.isInteger(birthday.month) || birthday.month < 1 || birthday.month > 12) return '生日月份必须是 1 至 12 的整数。';
  if (!Number.isInteger(birthday.day) || birthday.day < 1 || birthday.day > (birthday.calendar === 'lunar' ? 30 : 31)) return '生日日期超出有效范围。';
  if (birthday.year !== undefined && (!Number.isInteger(birthday.year) || birthday.year < 1900 || birthday.year > 2100)) return '生日年份必须是 1900 至 2100 的整数。';
  if (birthday.leap !== undefined && typeof birthday.leap !== 'boolean') return '闰月标记必须为布尔值。';
  if (birthday.calendar === 'solar' && birthday.leap) return '公历生日不能标记农历闰月。';
  if (birthday.calendar === 'solar' && birthday.day > daysInMonth(birthday.year ?? 2000, birthday.month)) return '该公历日期不存在。';
  if (birthday.year === undefined) return undefined;
  let solar: CivilDate | undefined;
  if (birthday.calendar === 'solar') solar = birthday as CivilDate;
  else {
    try { solar = lunarToSolar(birthday as Birthday & { year: number }); }
    catch { return CALENDAR_UNAVAILABLE; }
    if (!solar) return '该农历日期不存在，请检查年份、月份、日期及闰月。';
  }
  if (dateNumber(solar) > dateNumber(today(now))) return '生日不能晚于今天（按北京时间）。';
  return undefined;
}

function sunSign(month: number, day: number): string {
  const boundaries = [20, 19, 21, 20, 21, 22, 23, 23, 23, 24, 23, 22];
  const signs = ['摩羯座', '水瓶座', '双鱼座', '白羊座', '金牛座', '双子座', '巨蟹座', '狮子座', '处女座', '天秤座', '天蝎座', '射手座'];
  return signs[(month - 1 + (day >= boundaries[month - 1]! ? 1 : 0)) % 12]!;
}

/** Age is completed solar years in Shanghai, including for converted lunar birth dates.
 * Feb 29 anniversaries advance on March 1 in non-leap years. Zodiac changes at Chinese New Year.
 */
export function deriveBirthday(value: Birthday, now: Date = new Date()): BirthdayDerived {
  const error = validateBirthday(value, now);
  if (error) return { unsupported: error };
  const result: BirthdayDerived = {};
  const notes: string[] = [];
  let solar: CivilDate | undefined;
  if (value.calendar === 'solar') solar = { year: value.year ?? 2000, month: value.month, day: value.day };
  else if (value.year !== undefined) {
    try { solar = lunarToSolar(value as Birthday & { year: number }); }
    catch { notes.push(CALENDAR_UNAVAILABLE); }
  }
  if (value.year === undefined) {
    notes.push('未填写出生年份，无法计算年龄和生肖。');
    if (value.calendar === 'lunar') notes.push('农历生日缺少年份，无法验证当年的大小月或闰月，也无法换算公历及星座。');
  } else if (solar) {
    const current = today(now);
    result.age = current.year - solar.year - (current.month * 100 + current.day < solar.month * 100 + solar.day ? 1 : 0);
    try {
      const relatedYear = value.calendar === 'lunar' ? value.year : chineseParts(
        chineseFormatter(), new Date(Date.UTC(solar.year, solar.month - 1, solar.day, 12)),
      ).year;
      result.zodiac = ANIMALS[((relatedYear - 4) % 12 + 12) % 12];
    } catch { notes.push(`${CALENDAR_UNAVAILABLE}无法计算生肖。`); }
  }
  if (solar) {
    result.sunSign = sunSign(solar.month, solar.day);
    notes.push(APPROXIMATE);
  }
  if (notes.length) result.unsupported = notes.join(' ');
  return result;
}
