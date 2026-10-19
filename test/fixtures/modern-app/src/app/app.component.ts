import { Component, computed, input, output, signal } from '@angular/core';
import { TodosStore } from '@app/store/todos.store';

/** Root component. */
@Component({
  selector: 'app-root',
  template: `
    @if (count() > 0) {
      @for (todo of store.todos(); track todo) { <span>{{ todo }}</span> }
    }
    @defer { <span>later</span> }
  `,
})
export class AppComponent {
  readonly title = input.required<string>();
  readonly limit = input(10);
  readonly picked = output<string>();
  readonly store = new TodosStore();
  readonly count = computed(() => this.store.todos().length);
  readonly open = signal(false);
}
