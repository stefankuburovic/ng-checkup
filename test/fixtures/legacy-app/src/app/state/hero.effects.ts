import { Injectable } from '@angular/core';
import { Actions, createEffect } from '@ngrx/effects';
import type { HeroService } from '../hero.service';

@Injectable()
export class HeroEffects {
  constructor(private actions$: Actions, private service: HeroService) {}
  readonly load$ = createEffect(() => this.actions$, { dispatch: false });
}
