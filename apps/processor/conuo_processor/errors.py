"""Errors contain public codes only; never attach upstream payloads or credentials."""


class WorkerError(Exception):
    def __init__(self, code: str, *, retryable: bool = False):
        self.code = code
        self.retryable = retryable
        super().__init__(code)


class BudgetExpired(WorkerError):
    def __init__(self):
        super().__init__("BUDGET_EXPIRED")


class Cancelled(WorkerError):
    def __init__(self):
        super().__init__("CANCELLED")
