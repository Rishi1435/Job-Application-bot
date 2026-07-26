/**
 * Unit tests for the compensation reader and the pay bar.
 *
 * The bar is the rule that a posting is only recommended when the pay it
 * advertises clears a floor: 10 LPA for base salary, 15 LPA for CTC (which
 * bundles PF, gratuity, insurance, bonus and ESOPs, so it buys less).
 *
 * Most of what is checked here is the reader refusing to be fooled: a figure
 * near the word "CTC" is not automatically CTC, and a number with a currency
 * symbol is not automatically pay.
 *
 * Run with `npm test` (node:test, no extra dependencies).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCompensation, meetsPayBar, formatCompensation } = require('../services/compensation');

test('parseCompensation reads LPA, CTC and foreign annual figures', () => {
  const lpa = parseCompensation('Compensation: 12-18 LPA depending on experience.');
  assert.equal(lpa.stated, true);
  assert.equal(lpa.type, 'salary');
  assert.equal(lpa.min_lpa, 12);
  assert.equal(lpa.max_lpa, 18);

  const ctc = parseCompensation('Total CTC of 22 LPA including ESOPs.');
  assert.equal(ctc.type, 'ctc', 'a figure labelled CTC is CTC');

  // The label nearest the number wins, and a preceding label outranks a
  // trailing one - otherwise "Salary: 7 LPA. No CTC breakdown given." reads as
  // a CTC figure and is held to the wrong bar.
  const labelled = parseCompensation('Salary: 7 LPA. No CTC breakdown given.');
  assert.equal(labelled.type, 'salary');

  const usd = parseCompensation('Base salary $140,000 - $180,000 per year.');
  assert.equal(usd.stated, true);
  assert.equal(usd.type, 'salary');
  assert.ok(usd.max_lpa > 100, `${usd.max_lpa} LPA should reflect a 180k USD salary`);
});

test('parseCompensation ignores money that is not the candidate pay', () => {
  // A compute budget is the regression that produced this guard: Anthropic's
  // fellowship page offers "~$15k/month of compute", which parsed as a salary.
  const compute = parseCompensation('Fellows receive approximately $15,000 per month of compute budget.');
  assert.equal(compute.stated, false, 'a compute budget is not pay');

  assert.equal(parseCompensation('We raised $50M in Series B funding.').stated, false);
  assert.equal(parseCompensation('No salary information provided.').stated, false);
  assert.equal(parseCompensation('').stated, false);
});

test('parseCompensation annualises monthly and hourly rates', () => {
  const monthly = parseCompensation('Salary: INR 1,50,000 per month.');
  assert.equal(monthly.stated, true);
  assert.equal(monthly.max_lpa, 18, '1.5 lakh a month is 18 LPA');

  const hourly = parseCompensation('This role pays $60 per hour.');
  assert.equal(hourly.stated, true);
  // 60 USD/h * 2080 h * 88 INR = ~109 LPA
  assert.ok(hourly.max_lpa > 90 && hourly.max_lpa < 130, `${hourly.max_lpa} LPA is out of range`);
});

test('meetsPayBar applies 10 LPA to salary and 15 LPA to CTC', () => {
  assert.equal(meetsPayBar(parseCompensation('Salary: 12 LPA')).meets, true);
  assert.equal(meetsPayBar(parseCompensation('Salary: 7 LPA')).meets, false, 'under the 10 LPA salary bar');

  assert.equal(meetsPayBar(parseCompensation('CTC: 18 LPA')).meets, true);
  assert.equal(
    meetsPayBar(parseCompensation('CTC: 12 LPA')).meets,
    false,
    '12 LPA clears the salary bar but not the 15 LPA CTC bar'
  );

  // Unstated pay is never a reason to drop a posting.
  assert.equal(meetsPayBar(parseCompensation('No salary given')).meets, true);
  assert.equal(
    meetsPayBar(parseCompensation('CTC 6 LPA'), { jobType: 'Internship' }).meets,
    true,
    'internships are exempt'
  );
});

test('formatCompensation renders a readable pay label', () => {
  assert.equal(formatCompensation(parseCompensation('CTC: 18-22 LPA')), '18-22 LPA CTC');
  assert.equal(formatCompensation(parseCompensation('nothing here')), 'Not stated');
});
