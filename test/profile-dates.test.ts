import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBirthday, validateBirthday, type Birthday } from '../src/profile-dates.ts';

const now = new Date('2026-10-27T04:00:00Z');
const solar = (year: number | undefined, month: number, day: number): Birthday => ({ calendar: 'solar', year, month, day });
const lunar = (year: number | undefined, month: number, day: number, leap = false): Birthday => ({ calendar: 'lunar', year, month, day, leap });

test('zodiac follows Chinese New Year, not January 1', () => {
  assert.equal(deriveBirthday(solar(2024, 2, 9), now).zodiac, '兔');
  assert.equal(deriveBirthday(solar(2024, 2, 10), now).zodiac, '龙');
  assert.equal(deriveBirthday(solar(2024, 1, 1), now).zodiac, '兔');
});

test('2023 leap second month converts to March 22 and gives exact completed age', () => {
  const birthday = lunar(2023, 2, 1, true);
  const before = deriveBirthday(birthday, new Date('2024-03-21T15:59:59Z'));
  const on = deriveBirthday(birthday, new Date('2024-03-21T16:00:00Z'));
  assert.equal(before.age, 0);
  assert.equal(on.age, 1);
  assert.equal(on.zodiac, '兔');
  assert.equal(on.sunSign, '白羊座');
  assert.match(on.unsupported!, /估算/);
  assert.equal(deriveBirthday(lunar(2023, 2, 1), now).sunSign, '双鱼座');
});

test('late lunar year searches into next Gregorian year', () => {
  const result = deriveBirthday(lunar(2023, 12, 30), new Date('2025-02-09T04:00:00Z'));
  assert.equal(result.age, 1);
  assert.equal(result.zodiac, '兔');
  assert.equal(result.sunSign, '水瓶座');
});

test('invalid calendar dates never generate derived facts', () => {
  const invalid: unknown[] = [
    solar(2024, 2, 30), solar(2023, 2, 29), solar(undefined, 4, 31),
    lunar(2023, 1, 31), lunar(2024, 2, 1, true), lunar(2023, 2, 30, true),
    solar(1899, 1, 1), solar(2101, 1, 1), solar(2000.5, 1, 1),
    solar(2000, 0, 1), solar(2000, 13, 1), solar(2000, 1, 0), solar(2000, 1, 1.5),
    { calendar: 'solar', month: '1', day: 1 }, { calendar: 'solar', month: 1, day: 1, leap: true },
    { calendar: 'lunar', month: 1, day: 1, leap: 'yes' }, { calendar: 'other', month: 1, day: 1 },
    null, [], {},
  ];
  for (const value of invalid) {
    assert.equal(typeof validateBirthday(value, now), 'string', JSON.stringify(value));
    const derived = deriveBirthday(value as Birthday, now);
    assert.deepEqual(Object.keys(derived), ['unsupported'], JSON.stringify(value));
  }
});

test('missing year is valid but missing month or day is incomplete', () => {
  assert.equal(validateBirthday(solar(undefined, 2, 29), now), undefined);
  assert.match(validateBirthday({ calendar: 'solar', month: 2 }, now)!, /不完整/);
  const result = deriveBirthday(solar(undefined, 2, 29), now);
  assert.equal(result.sunSign, '双鱼座');
  assert.equal(result.age, undefined);
  assert.equal(result.zodiac, undefined);
  assert.match(result.unsupported!, /未填写出生年份/);
  const incomplete = deriveBirthday(lunar(undefined, 2, 30, true), now);
  assert.equal(incomplete.sunSign, undefined);
  assert.equal(incomplete.age, undefined);
  assert.equal(incomplete.zodiac, undefined);
  assert.match(incomplete.unsupported!, /无法验证/);
});

test('future dates are invalid; today is valid in Shanghai independent of host timezone', () => {
  const midnight = new Date('2024-02-09T16:00:00Z');
  assert.equal(validateBirthday(solar(2024, 2, 10), midnight), undefined);
  assert.match(validateBirthday(solar(2024, 2, 11), midnight)!, /不能晚于今天/);
  assert.equal(validateBirthday(lunar(2024, 1, 1), midnight), undefined);
  assert.match(validateBirthday(lunar(2024, 1, 2), midnight)!, /不能晚于今天/);
  assert.equal(deriveBirthday(lunar(2024, 1, 1), midnight).age, 0);
  assert.match(validateBirthday(solar(2000, 1, 1), new Date(NaN))!, /当前日期无效/);
});

test('solar age changes on birthday; leap-day birthday advances on March 1', () => {
  assert.equal(deriveBirthday(solar(2000, 10, 28), now).age, 25);
  assert.equal(deriveBirthday(solar(2000, 10, 27), now).age, 26);
  assert.equal(deriveBirthday(solar(2000, 2, 29), new Date('2025-02-28T04:00:00Z')).age, 24);
  assert.equal(deriveBirthday(solar(2000, 2, 29), new Date('2025-03-01T04:00:00Z')).age, 25);
});

test('sun-sign conventional boundaries and year wrap carry approximation warning', () => {
  for (const [month, before, after] of [
    [1, '摩羯座', '水瓶座'], [2, '水瓶座', '双鱼座'], [3, '双鱼座', '白羊座'],
    [4, '白羊座', '金牛座'], [5, '金牛座', '双子座'], [6, '双子座', '巨蟹座'],
    [7, '巨蟹座', '狮子座'], [8, '狮子座', '处女座'], [9, '处女座', '天秤座'],
    [10, '天秤座', '天蝎座'], [11, '天蝎座', '射手座'], [12, '射手座', '摩羯座'],
  ] as const) {
    const boundary = [20, 19, 21, 20, 21, 22, 23, 23, 23, 24, 23, 22][month - 1]!;
    assert.equal(deriveBirthday(solar(2000, month, boundary - 1), now).sunSign, before);
    const result = deriveBirthday(solar(2000, month, boundary), now);
    assert.equal(result.sunSign, after);
    assert.match(result.unsupported!, /交界日可能有差异/);
  }
});

test('supported year endpoints are validated without clamping or calendar rollover', () => {
  const futureNow = new Date('2102-01-01T04:00:00Z');
  assert.equal(validateBirthday(lunar(1900, 1, 1), futureNow), undefined);
  assert.equal(validateBirthday(lunar(2100, 1, 1), futureNow), undefined);
  assert.equal(deriveBirthday(lunar(1900, 1, 1), futureNow).zodiac, '鼠');
});
