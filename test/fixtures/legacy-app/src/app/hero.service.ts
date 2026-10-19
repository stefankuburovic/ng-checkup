import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { heroReducer } from './state/hero.reducer';

@Injectable({ providedIn: 'root' })
export class HeroService {
  readonly heroes = new BehaviorSubject<string[]>([]);
  readonly reducer = heroReducer;
  load(): void {}
}
