package extras.embeddedkeys;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Warehouse {
  @Id private Long id;

  @Column(nullable = false, length = 60)
  private String city;

  public Long getId() {
    return id;
  }

  public String getCity() {
    return city;
  }
}
