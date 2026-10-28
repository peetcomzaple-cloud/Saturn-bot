import importlib.machinery
import importlib.util
import unittest
from pathlib import Path

SOURCE=Path(__file__).with_name('rakazo-page-browser')
loader=importlib.machinery.SourceFileLoader('foreground_helper',str(SOURCE))
spec=importlib.util.spec_from_loader(loader.name,loader)
helper=importlib.util.module_from_spec(spec)
loader.exec_module(helper)

class SelectedForeground(unittest.TestCase):
    def invoke(self,value,exception=False,fail_activation=False):
        calls=[]
        class Client:
            def call(self,method,params=None,**kwargs):
                calls.append((method,params,kwargs))
                if method=='Page.bringToFront':
                    if fail_activation:raise TimeoutError('activation failed')
                    return {}
                return {'result':{'value':value},**({'exceptionDetails':{'text':'failed'}} if exception else {})}
        helper.activate_selected_page(Client(),'actual-session')
        return calls

    def test_visible_selected_session_is_activated_before_observing(self):
        calls=self.invoke(True)
        self.assertEqual([c[0] for c in calls],['Page.bringToFront','Runtime.evaluate'])
        self.assertTrue(all(c[2]['session_id']=='actual-session' for c in calls))
        self.assertTrue(all(c[2]['timeout_s']==3 for c in calls))

    def test_hidden_tab_cannot_be_used(self):
        for value in (False,None,1,'true'):
            with self.subTest(value=value),self.assertRaises(RuntimeError):self.invoke(value)

    def test_evaluation_exception_is_not_visible(self):
        with self.assertRaises(RuntimeError):self.invoke(True,exception=True)

    def test_failed_activation_is_not_swallowed(self):
        with self.assertRaises(TimeoutError):self.invoke(True,fail_activation=True)
