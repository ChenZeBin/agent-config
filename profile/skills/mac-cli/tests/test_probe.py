import importlib.util
import pathlib
import unittest

spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).resolve().parents[1]/'scripts/probe.py')
probe=importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

class NetworkQualityTest(unittest.TestCase):
    def result(self,output,exit_code=0,timed_out=False):
        return {'stdout':output,'stderr':'','exit_code':exit_code,'timed_out':timed_out}
    def test_positive_measurement(self):
        self.assertTrue(probe.network_quality_ok(self.result('Uplink capacity: 20.5 Mbps\nDownlink capacity: 800 Mbps\n')))
    def test_http_error_with_zero_exit(self):
        self.assertFalse(probe.network_quality_ok(self.result('Uplink capacity: 0.000 bps\nDownlink capacity: 3.138 Mbps\nTotal Network Errors: 1\nError: Expected HTTP status code 200, got 413\n')))
    def test_error_even_with_positive_capacities(self):
        self.assertFalse(probe.network_quality_ok(self.result('Uplink capacity: 20 Mbps\nDownlink capacity: 800 Mbps\nTotal Network Errors: 1\n')))
    def test_zero_capacity(self):
        self.assertFalse(probe.network_quality_ok(self.result('Uplink capacity: 0.000 bps\nDownlink capacity: 3.138 Mbps\n')))
    def test_missing_measurement(self):
        self.assertFalse(probe.network_quality_ok(self.result('Uplink capacity:\nDownlink capacity:\n')))
    def test_timeout_and_exit(self):
        output='Uplink capacity: 20 Mbps\nDownlink capacity: 800 Mbps\n'
        self.assertFalse(probe.network_quality_ok(self.result(output,timed_out=True)))
        self.assertFalse(probe.network_quality_ok(self.result(output,exit_code=1)))

if __name__=='__main__':unittest.main()
