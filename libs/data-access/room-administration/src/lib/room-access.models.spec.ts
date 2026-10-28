import {
  HistoryVisibility as SdkHistoryVisibility,
  JoinRule as SdkJoinRule,
  RestrictedAllowType as SdkRestrictedAllowType,
} from 'matrix-js-sdk';
import {
  HistoryVisibility,
  JoinRule,
  RestrictedAllowType,
} from './room-access.models';

describe('room access constants', () => {
  it('match the matrix-js-sdk enums member for member', () => {
    expect(JoinRule).toEqual(SdkJoinRule);
    expect(HistoryVisibility).toEqual(SdkHistoryVisibility);
    expect(RestrictedAllowType).toEqual(SdkRestrictedAllowType);
  });
});
