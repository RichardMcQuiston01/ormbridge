package extras.single;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import java.util.ArrayList;
import java.util.List;

@Entity
public class Depot {
  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  private String city;

  // Points at the subclass: its rows live in the table of Vehicle.
  @OneToMany(mappedBy = "depot")
  private List<Truck> trucks = new ArrayList<>();
}
