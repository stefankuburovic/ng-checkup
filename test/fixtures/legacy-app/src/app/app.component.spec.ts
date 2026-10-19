import { fakeAsync, tick } from '@angular/core/testing';

describe('AppComponent', () => {
  it('waits', fakeAsync(() => {
    const spy = jasmine.createSpy('load');
    spyOn(console, 'log');
    tick(100);
    expect(spy).not.toHaveBeenCalled();
  }));
});
