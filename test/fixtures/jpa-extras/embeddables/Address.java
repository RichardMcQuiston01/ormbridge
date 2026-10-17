package extras.embed;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.persistence.Embedded;

@Embeddable
public class Address {
  @Column(length = 80)
  private String street;

  @Column(nullable = false)
  private String city;

  @Embedded private Geo geo;
}
