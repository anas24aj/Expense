import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # tests live next to app/*.py
from test_expense import StatementReaderTest  # noqa: E402,F401  (re-exported so discover finds it)
