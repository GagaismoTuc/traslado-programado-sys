# Traslado programado

Scheduled transport of children with disabilities between their homes and the institutions they attend (schools, therapy, clinics, day centres). The system replaces the daily Word schedule and the WhatsApp group used to plan and follow each day's trips.

Terms are in Spanish, the language the client uses; the English name in parentheses is the one used in code.

## People and fleet

**Pasajero** (Passenger):
A child the company transports.
_Avoid_: chico, paciente, alumno

**Acompañante** (Companion):
An adult who must travel with a specific Pasajero and takes a seat in the Vehículo.
_Avoid_: tutor, asistente

**Chofer** (Driver):
A person who drives a Vehículo on each of their Recorridos, usually the same one; when it breaks down they carry on with a replacement Vehículo.
_Avoid_: conductor, chango

**Chofer habitual** (Usual driver):
The Chofer a Pasajero usually travels with. The Oficina keeps it when it can, because the child bonds with the driver.
_Avoid_: chofer fijo, chofer asignado

**Vehículo** (Vehicle):
A van of the fleet, identified by its plate, with a fixed number of seats for Pasajeros and Acompañantes.
_Avoid_: móvil, unidad, camioneta

**Vehículo habitual** (Usual vehicle):
The active Vehículo a Chofer usually drives, used as the default when a new Recorrido is created for that Chofer. Optional for replacement drivers who do not have a fixed van.
_Avoid_: móvil fijo, camioneta asignada

**Adulto autorizado** (Authorized adult):
A person the family names as allowed to receive a Pasajero at home.
_Avoid_: responsable, tutor (as a delivery role)

**Responsable legal** (Legal guardian):
The Adulto autorizado who signed the Pasajero's Consentimiento. Only they can give an Autorización puntual.
_Avoid_: tutor, padre, titular

**Autorización puntual** (One-off authorization):
Permission a Responsable legal gives by phone, recorded by the Oficina, to hand a Pasajero to one named adult on one Traslado when nobody else can receive them. It is used once.
_Avoid_: permiso, excepción

**Receptor** (Receiver):
The person who actually received a Pasajero when it was marked Entregado: an Adulto autorizado, the Destino, the receiving Chofer in a Trasbordo, another adult identified by name and DNI when the Pasajero's Consentimiento or an Autorización puntual allows it, or, when nobody can receive the Pasajero, the company's staff at its base.
_Avoid_: quien recibe, firmante

**Adaptación** (Vehicle feature):
Equipment a Vehículo has that some Pasajeros require, such as a wheelchair ramp.
_Avoid_: equipamiento, accesorio

**Asiento delantero** (Front seat):
The seat next to the Chofer. A Vehículo has one, and some Pasajeros must always travel in it.
_Avoid_: adelante, copiloto

**Vencimiento** (Expiry):
The date on which a document of a Vehículo or a Chofer stops being valid, such as the VTV, the driving licence or the health certificate.
_Avoid_: caducidad, renovación

**Oficina** (Office):
The staff who plan and follow the day: the owner, the planner and the secretary. All of them have the same permissions.
_Avoid_: administrador, secretario (as role names)

## Planning

**Destino** (Destination):
An institution, or one of its sites, that a Pasajero attends, such as a school, clinic, therapy centre or day centre. Each site of an institution is its own Destino.
_Avoid_: institución, escuela, lugar

**Tolerancia de llegada** (Arrival tolerance):
How many minutes after the target time a Pasajero may still arrive at a Destino. Therapy centres allow none; schools and day centres allow half an hour.
_Avoid_: margen, demora permitida

**Traslado** (Transfer):
One leg of one Pasajero between their home and a Destino, or between two Destinos, with a target time. An *entrada* ends at a Destino and targets the arrival time; it usually starts at home but may start at another Destino. A *salida* goes Destino → home and targets the pick-up time.
_Avoid_: viaje, servicio

**Distancia directa** (Direct distance):
The road distance of a Traslado as if the Pasajero travelled alone between home and the Destino, without the detours of a shared Recorrido. It is what obras sociales pay for.
_Avoid_: km recorridos, kilometraje

**Recorrido** (Route):
The ordered stops one Vehículo with its Chofer makes in one part of the day, serving several Traslados.
_Avoid_: ruta, vuelta

**Versión del plan** (Plan version):
A numbered, published state of one Recorrido. Each publication creates the next version.
_Avoid_: revisión, edición

**Publicación forzada** (Override):
A Versión del plan the Oficina publishes although it breaks a limit, with a recorded reason. It never covers a Pasajero left without a Recorrido.
_Avoid_: override, excepción

**Plan diario** (Daily plan):
All the Recorridos and Traslados of one day.
_Avoid_: horario, planilla, cronograma

**Ausencia** (Absence):
Notice that a Pasajero will not travel on a given Traslado.
_Avoid_: falta

**Tiempo máximo a bordo** (Maximum ride time):
The longest a given Pasajero may stay in the Vehículo during one Traslado.
_Avoid_: duración máxima

**Consentimiento** (Consent):
The written authorization from a Pasajero's family to keep and use the Pasajero's data. A Pasajero is not transported through the system without it.
_Avoid_: autorización, permiso

## Execution

**Marca** (Mark):
A Chofer's record of what happened to a Pasajero on a Traslado: Subió, Ausente, Entregado, or a Corrección of one of them. Marks are never edited or deleted.
_Avoid_: registro, check

**Corrección** (Correction):
A Marca that replaces an earlier Marca of the same Traslado without changing it. The Chofer can make one within 2 minutes of the original; after that only the Oficina can, with a reason.
_Avoid_: edición, anulación

**Confirmación de versión** (Version acknowledgement):
A Chofer's record of having seen a given Versión del plan.
_Avoid_: acuse, ack

**Subió** (Boarded):
The Chofer's mark that a Pasajero got into the Vehículo, with the time and place it happened.

**Ausente** (No-show):
The Chofer's mark that a Pasajero was not there to be picked up.

**Entregado** (Delivered):
The Chofer's mark that a Pasajero was handed over at the end of a Traslado. Its time is the proof given to families and institutions.
_Avoid_: llegó, presente

**Trasbordo** (Transshipment):
The handover of a Pasajero who is on board from one Chofer to another during a Traslado. The Oficina plans it at a fixed place and time, or it happens during a Recorrido, for example when a Vehículo breaks down. It is recorded as an Entregado to the receiving Chofer and a Subió in the receiving Recorrido.
_Avoid_: traspaso, transbordo, cambio de vehículo

**Incidente** (Incident):
A problem reported by a Chofer during a Recorrido, such as a delay, a vehicle fault or an accident.
_Avoid_: emergencia, novedad
