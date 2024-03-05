import uuid
from unittest import mock

import pytest
import sentry_sdk
from django.test.utils import override_settings
from sentry_sdk import Hub

from sentry import eventstore
from sentry.eventstore.models import Event
from sentry.models.userrole import manage_default_super_admin_role
from sentry.receivers import create_default_projects
from sentry.silo.base import SiloMode
from sentry.testutils.asserts import assert_mock_called_once_with_partial
from sentry.testutils.pytest.fixtures import django_db_all
from sentry.testutils.pytest.relay import adjust_settings_for_relay_tests
from sentry.testutils.silo import assume_test_silo_mode, no_silo_test
from sentry.testutils.skips import requires_kafka
from sentry.utils.sdk import bind_organization_context, configure_sdk

pytestmark = [requires_kafka]


@pytest.fixture(autouse=True)
def setup_fixtures():
    with assume_test_silo_mode(SiloMode.CONTROL):
        manage_default_super_admin_role()
    create_default_projects()


@pytest.fixture
def post_event_with_sdk(settings, relay_server, wait_for_ingest_consumer):
    adjust_settings_for_relay_tests(settings)
    settings.SENTRY_ENDPOINT = relay_server["url"]
    settings.SENTRY_PROJECT = 1

    configure_sdk()

    wait_for_ingest_consumer = wait_for_ingest_consumer(settings)

    def inner(*args, **kwargs):
        event_id = sentry_sdk.capture_event(*args, **kwargs)
        sentry_sdk.Scope.get_client().flush()

        with sentry_sdk.new_scope():
            return wait_for_ingest_consumer(
                lambda: eventstore.backend.get_event_by_id(settings.SENTRY_PROJECT, event_id)
            )

    yield inner


@no_silo_test
@override_settings(SENTRY_PROJECT=1)
@django_db_all
def test_simple(settings, post_event_with_sdk):
    event = post_event_with_sdk({"message": "internal client test"})

    assert event
    assert event.data["project"] == settings.SENTRY_PROJECT
    assert event.data["logentry"]["formatted"] == "internal client test"


@no_silo_test
@override_settings(SENTRY_PROJECT=1)
@django_db_all
def test_recursion_breaker(settings, post_event_with_sdk):
    # If this test terminates at all then we avoided recursion.
    settings.SENTRY_INGEST_CONSUMER_APM_SAMPLING = 1.0
    settings.SENTRY_PROJECT = 1

    event_id = uuid.uuid4().hex
    with mock.patch(
        "sentry.event_manager.EventManager.save", spec=Event, side_effect=ValueError("oh no!")
    ) as save:
        with pytest.raises(ValueError):
            post_event_with_sdk({"message": "internal client test", "event_id": event_id})

    assert_mock_called_once_with_partial(save, settings.SENTRY_PROJECT, cache_key=f"e:{event_id}:1")


@no_silo_test
@django_db_all
@override_settings(SENTRY_PROJECT=1)
def test_encoding(settings, post_event_with_sdk):
    class NotJSONSerializable:
        pass

    with sentry_sdk.new_scope() as scope:
        scope.set_extra("request", NotJSONSerializable())
        event = post_event_with_sdk({"message": "check the req"})

    assert event.data["project"] == settings.SENTRY_PROJECT
    assert event.data["logentry"]["formatted"] == "check the req"
    assert "NotJSONSerializable" in event.data["extra"]["request"]


@no_silo_test
@override_settings(SENTRY_PROJECT=1)
@django_db_all
def test_bind_organization_context(default_organization):
    configure_sdk()

    bind_organization_context(default_organization)

    assert Hub.current.scope._tags["organization"] == default_organization.id
    assert Hub.current.scope._tags["organization.slug"] == default_organization.slug
    assert Hub.current.scope._contexts["organization"] == {
        "id": default_organization.id,
        "slug": default_organization.slug,
    }


@no_silo_test
@override_settings(SENTRY_PROJECT=1)
@django_db_all
def test_bind_organization_context_with_callback(default_organization):
    create_default_projects()
    configure_sdk()

    def add_context(scope, organization, **kwargs):
        scope.set_tag("organization.test", "1")

    with override_settings(SENTRY_ORGANIZATION_CONTEXT_HELPER=add_context):
        bind_organization_context(default_organization)
        assert Hub.current.scope._tags["organization.test"] == "1"


@no_silo_test
@override_settings(SENTRY_PROJECT=1)
@django_db_all
def test_bind_organization_context_with_callback_error(default_organization):
    configure_sdk()

    def add_context(scope, organization, **kwargs):
        1 / 0

    with override_settings(SENTRY_ORGANIZATION_CONTEXT_HELPER=add_context):
        bind_organization_context(default_organization)
        assert Hub.current.scope._tags["organization"] == default_organization.id
