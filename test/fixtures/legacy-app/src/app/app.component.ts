import { Component, NgZone } from '@angular/core';
import { HeroService } from './hero.service';

@Component({ selector: 'app-root', templateUrl: './app.component.html' })
export class AppComponent {
  heroes: any[] = [];
  constructor(private zone: NgZone, private heroes$: HeroService) {
    // @ts-ignore
    this.zone.runOutsideAngular(() => this.heroes$.load()!);
  }
}
