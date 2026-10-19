import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-hero-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ul><li *ngIf="heroes">{{ heroes.length }}</li></ul>`,
})
export class HeroListComponent {
  @Input() heroes: any;
  @Output() selected = new EventEmitter<string>();
}
