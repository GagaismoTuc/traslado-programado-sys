import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubErrorEvent, scrubBreadcrumb, scrubString, stripUrlQueryAndFragment } from './error-scrubbing.ts';
test('passenger payload in error exception', () => {
  const passenger = {name:'Synthetic Passenger',homeAddress:'Synthetic Road 42',dni:'45678901'};
  const event = scrubErrorEvent({exception:{values:[{value:`Database failed for passenger ${JSON.stringify(passenger)}`}]}});
  for (const value of Object.values(passenger)) assert.ok(!JSON.stringify(event).includes(value), value);
});
test('free text database error does not leak passenger name and address', () => {
  const event = scrubErrorEvent({exception:{values:[{value:'Failing row contains (Synthetic Passenger, Synthetic Road 42).'}]}});
  assert.doesNotMatch(JSON.stringify(event), /Synthetic Passenger|Synthetic Road 42/);
});
test('unquoted key value removes whole passenger name', () => {
  assert.doesNotMatch(scrubString('failed name=Synthetic Passenger'), /Passenger/);
});
test('positional integer GPS pairs are removed', () => {
  assert.doesNotMatch(JSON.stringify(scrubErrorEvent({extra:{waypoint:[-65,-26]}})), /-65|-26/);
});
test('URL query and navigation fragments removed', () => {
  assert.equal(stripUrlQueryAndFragment('https://example.invalid/a?name=Synthetic#x'),'https://example.invalid/a');
  assert.deepEqual(scrubBreadcrumb({category:'navigation',data:{from:'/a?name=Synthetic',to:'/b#Synthetic'}})?.data,{from:'/a',to:'/b'});
});

