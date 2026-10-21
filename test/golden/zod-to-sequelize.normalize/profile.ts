import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  declare id: number;
  declare bio: CreationOptional<string | null>;
  declare avatar: CreationOptional<string | null>;
  declare userId: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof Profile {
    Profile.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        bio: DataTypes.TEXT,
        avatar: DataTypes.STRING(100),
        userId: { type: DataTypes.INTEGER, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Profile',
        tableName: 'profile',
        timestamps: true,
        underscored: true,
      }
    );
    return Profile;
  }
}
