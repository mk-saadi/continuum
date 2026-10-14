const test = require('node:test');
const assert = require('node:assert/strict');
const {variantFromRow,parseVariants} = require('../src/main/messageVariants');
test('reply status stays with each response version', () => {
  const interrupted = variantFromRow({content:'Partial',status:'interrupted'});
  const completed = variantFromRow({content:'Retry',status:'completed'});
  const variants = parseVariants({status:'interrupted',active_variant_index:1,variants:JSON.stringify([interrupted,completed])});
  assert.equal(variants[0].status,'interrupted');
  assert.equal(variants[1].status,'completed');
});
test('legacy metadata uses row status only for its selected version', () => {
  const variants = parseVariants({status:'interrupted',active_variant_index:0,variants:[{content:'Partial'},{content:'Other'}]});
  assert.equal(variants[0].status,'interrupted');
  assert.equal(variants[1].status,'completed');
});
