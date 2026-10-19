import { Injectable } from '@angular/core';
import { signalStore, withState } from '@ngrx/signals';
import type { AppComponent } from '@app/app.component';

/** Todos. The type-only import of AppComponent must not count as a cycle. */
@Injectable({ providedIn: 'root' })
export class TodosStore extends signalStore(withState({ todos: [] as string[] })) {
  owner?: AppComponent;
}
