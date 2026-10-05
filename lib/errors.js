'use strict';
class ConflictError extends Error {
  constructor(currentUpdatedAt) {
    super('다른 기기(또는 다른 창)에서 먼저 수정된 데이터가 있어 저장하지 않았습니다.');
    this.name = 'ConflictError';
    this.currentUpdatedAt = currentUpdatedAt;
  }
}
class TooLargeError extends Error {
  constructor() { super('데이터가 너무 커서 시트에 저장할 수 없습니다.'); this.name = 'TooLargeError'; }
}
class DataCorruptError extends Error {
  constructor(where, cause) {
    super(`시트의 ${where} 데이터를 읽을 수 없습니다 (JSON 형식 오류). 데이터는 건드리지 않았습니다.`);
    this.name = 'DataCorruptError';
    this.cause = cause;
  }
}
module.exports = { ConflictError, TooLargeError, DataCorruptError };
