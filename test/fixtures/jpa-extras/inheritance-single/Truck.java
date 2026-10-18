package extras.single;

import jakarta.persistence.DiscriminatorValue;
import jakarta.persistence.Entity;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;

@Entity
@DiscriminatorValue("T")
public class Truck extends Vehicle {
  private Integer axles;

  @ManyToOne(optional = false)
  @JoinColumn(name = "depot_id", nullable = false)
  private Depot depot;
}
