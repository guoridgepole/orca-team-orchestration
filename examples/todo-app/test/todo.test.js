import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStore } from '../src/store.js';
import { createTodoServer } from '../src/server.js';

test('store 支持新增、完成与列表', () => {
  const store = createStore();
  const todo = store.add('买牛奶');
  assert.equal(todo.done, false);
  store.complete(todo.id);
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].done, true);
});

test('HTTP 接口覆盖 story-002 验收', async () => {
  const server = createTodoServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await fetch(`${base}/todos`, {
    method: 'POST',
    body: JSON.stringify({ title: '写周报' }),
  });
  assert.equal(created.status, 201);
  const todo = await created.json();

  const completed = await fetch(`${base}/todos/${todo.id}/complete`, { method: 'POST' });
  assert.equal(completed.status, 200);

  const list = await (await fetch(`${base}/todos`)).json();
  assert.deepEqual(list.map((item) => [item.title, item.done]), [['写周报', true]]);
  server.close();
});
