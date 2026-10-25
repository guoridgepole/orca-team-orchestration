import { randomUUID } from 'node:crypto';

export function createStore() {
  const todos = new Map();

  return {
    add(title) {
      if (typeof title !== 'string' || title.trim() === '') {
        throw new Error('待办标题不能为空');
      }
      const todo = { id: randomUUID(), title: title.trim(), done: false };
      todos.set(todo.id, todo);
      return todo;
    },
    complete(id) {
      const todo = todos.get(id);
      if (!todo) throw new Error(`待办不存在: ${id}`);
      todo.done = true;
      return todo;
    },
    list() {
      return [...todos.values()];
    },
  };
}
