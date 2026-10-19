import { NgModule } from '@angular/core';
import { AppComponent } from './app.component';
import { HeroListComponent } from './hero-list/hero-list.component';

@NgModule({ declarations: [AppComponent, HeroListComponent], bootstrap: [AppComponent] })
export class AppModule {}
