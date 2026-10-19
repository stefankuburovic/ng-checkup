import { APP_INITIALIZER, ChangeDetectionStrategy, Component, inject, provideLegacyThing } from '@angular/core';
import { AsyncPipe, NgIf } from '@angular/common';

export const config = [{ provide: APP_INITIALIZER, useValue: () => inject(String), multi: true }, provideLegacyThing];

@Component({
  selector: 'app-old',
  changeDetection: ChangeDetectionStrategy.Default,
  imports: [NgIf, AsyncPipe],
  template: '<p *ngIf="true">old</p>',
})
export class OldComponent {}
