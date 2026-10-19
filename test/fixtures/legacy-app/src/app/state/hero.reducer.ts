import { createAction, createReducer, on } from '@ngrx/store';
import { HeroService } from '../hero.service';

export const loaded = createAction('[Hero] Loaded');
export const heroReducer = createReducer([] as string[], on(loaded, (state) => state));
export const serviceToken = HeroService;
