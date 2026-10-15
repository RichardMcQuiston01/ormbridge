package models

import "time"

// Profile maps to the "profiles" table.
type Profile struct {
	ID        int32     `gorm:"primaryKey;autoIncrement"`
	Bio       *string   `gorm:"type:text"`
	Avatar    *string   `gorm:"size:100"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`
	UserID    int32     `gorm:"not null;unique"`

	User User `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
}
